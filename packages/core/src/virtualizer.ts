import { EventEmitter } from "typed-events";

export type Cursor = {
	offset: bigint;
	size: bigint;
};

export type VirtualizerOptions = {
	target: HTMLElement | string;
	items?: (string | HTMLElement)[] | string;
	cursor?: Cursor;
	renderWindow?: bigint;
	visibleWindow?: bigint;
	dontVirtualizeIf?: (element: HTMLElement) => boolean;
	rectProvider?: (element: HTMLElement) => DOMRect;
	removeElementWhenHidden?: boolean;
	useTargetScroll?: boolean;
	disableScrollCursor?: boolean;
};

export type VirtualizationManagerOptions = Partial<{
	cursor: Cursor;
	visibleWindow: bigint;
	renderWindow: bigint;
}>;

export type VirtualizerContext = {
	target: HTMLElement | null;
	elements: HTMLElement[];
	manager: VirtualizationManager;
};

export class VirtualizationManager {
	cursor: Cursor;
	visibleWindow: bigint;
	renderWindow: bigint;
	items: Map<string, bigint> = new Map();

	constructor(options: VirtualizationManagerOptions) {
		this.cursor = options.cursor ?? { offset: 0n, size: 1024n };
		this.visibleWindow = options.visibleWindow ?? 1024n;
		this.renderWindow = options.renderWindow ?? 1024n;
	}

	getItemSize(item: bigint): bigint {
		return item >> 32n;
	}

	getItemOffset(item: bigint): bigint {
		return item & 0xffffffffn;
	}

	makeItem(size: bigint, offset: bigint): bigint {
		return (size << 32n) | offset;
	}

	isItemInWindow(item: bigint, windowSize: bigint): boolean {
		const offset = this.getItemOffset(item);
		const size = this.getItemSize(item);
		const { offset: cursorStart, size: cursorSize } = this.cursor;
		const windowStart = cursorStart - windowSize;
		const windowEnd = cursorStart + cursorSize + windowSize;
		return (
			(offset >= windowStart && offset <= windowEnd) ||
			(offset + size >= windowStart && offset + size <= windowEnd) ||
			(offset <= windowStart && offset + size >= windowEnd)
		);
	}

	isItemVisible(item: bigint): boolean {
		return this.isItemInWindow(item, this.visibleWindow);
	}

	isItemRenderable(item: bigint): boolean {
		return this.isItemInWindow(item, this.renderWindow);
	}

	updateItem(key: string, size: bigint, offset: bigint): void {
		this.items.set(key, this.makeItem(size, offset));
	}

	getItem(key: string): bigint | undefined {
		return this.items.get(key);
	}

	removeItem(key: string): void {
		this.items.delete(key);
	}
}

export type VirtualizerEvents = {
	added: [element: HTMLElement];
	updated: [element: HTMLElement];
	hidden: [element: HTMLElement];
	rendered: [element: HTMLElement];
	visible: [element: HTMLElement];
};

export class Virtualizer extends EventEmitter<VirtualizerEvents> {
	ctx: VirtualizerContext;
	options: VirtualizerOptions;
	#observer: MutationObserver;
	#targetObserver: MutationObserver;
	#previousTarget: HTMLElement | null = null;
	#idleCallbackId: number | null = null;
	#contextTimer: ReturnType<typeof setInterval>;
	#garbageTimer: ReturnType<typeof setInterval>;
	private _removedElementMap: Map<string, HTMLElement> = new Map();
	private _scrollElem: HTMLElement | Window | null = null;
	private _boundScrollListener!: () => void;

	constructor(options: VirtualizerOptions) {
		super();
		this.options = options;
	}

	start() {
		this.ctx = this.initializeContext();
		this.refreshItems();
		this.#observer = new MutationObserver((mutations) => this.handleMutations(mutations));
		this.attachObservers();
		this.updateDisplay();
		if (this.ctx.target) {
			this.#targetObserver = new MutationObserver(() => {
				this.refreshElements();
			});
			this.#targetObserver.observe(this.ctx.target, { childList: true });
		}
		this.#contextTimer = setInterval(() => this.refreshContext(), 1000);
		this.#garbageTimer = setInterval(
			() =>
				this.enqueueIdleTask(() => {
					this.cleanObservers();
				}),
			10000,
		);
		if (!this.options.disableScrollCursor) {
			// Use throttled scroll listener (max once per 50ms)
			this._boundScrollListener = this.throttle(this._onScroll.bind(this), 50);
			if (
				this.ctx.target &&
				(getComputedStyle(this.ctx.target).overflow === "auto" ||
					this.ctx.target.classList.contains("overflow-auto") ||
					this.options.useTargetScroll)
			) {
				this._scrollElem = this.ctx.target;
			} else {
				this._scrollElem = window;
			}
			this._scrollElem.addEventListener("scroll", this._boundScrollListener);
		}
	}

	private _onScroll(): void {
		let scrollTop: number;
		if (this._scrollElem instanceof HTMLElement) {
			scrollTop = this._scrollElem.scrollTop;
		} else {
			scrollTop = window.scrollY;
		}
		this.setCursorOffset(BigInt(Math.round(scrollTop)));
	}

	initializeContext(): VirtualizerContext {
		const target = this.resolveTarget();
		const elements = this.resolveElements(target);
		const manager = new VirtualizationManager({
			cursor: this.options.cursor,
			renderWindow: this.options.renderWindow,
			visibleWindow: this.options.visibleWindow,
		});
		this.#previousTarget = target;
		return { target, elements, manager };
	}

	resolveTarget(): HTMLElement | null {
		if (typeof this.options.target === "string") {
			const el = document.querySelector(this.options.target);
			return el instanceof HTMLElement ? el : null;
		}
		return this.options.target;
	}

	resolveElements(target: HTMLElement | null): HTMLElement[] {
		if (Array.isArray(this.options.items)) {
			return this.options.items
				.map((item) => (typeof item === "string" ? document.querySelector(item) : item))
				.filter((el): el is HTMLElement => el instanceof HTMLElement);
		}
		if (typeof this.options.items === "string") {
			return Array.from(document.querySelectorAll(this.options.items));
		}
		return target instanceof HTMLElement
			? Array.from(target.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
			: [];
	}

	refreshContext(): void {
		this.updateTarget();
		if (this.ctx.target !== this.#previousTarget) {
			this.refreshElements();
			this.#previousTarget = this.ctx.target;
		}
	}

	refreshElements(): void {
		this.ctx.elements = this.resolveElements(this.ctx.target);
		this.refreshItems();
		this.attachObservers();
		this.updateDisplay();
	}

	updateTarget(): void {
		if (typeof this.options.target === "string") {
			this.ctx.target = this.resolveTarget();
		}
	}

	refreshItems(): void {
		this.ctx.elements.forEach((el) => {
			if (el.classList.contains("virtualizer-hidden")) return

			const key = this.getElementKey(el);
			const rect = this.options.rectProvider ? this.options.rectProvider(el) : el.getBoundingClientRect();
			const size = BigInt(Math.round(rect.height));
			const offset = BigInt(Math.round(rect.top));
			this.ctx.manager.updateItem(key, size, offset);
			if (!el.classList.contains("virtualizer-item")) {
				el.classList.add("virtualizer-item");
				this.emit("added", el);
			}
		});
	}

	handleMutations(mutations: MutationRecord[]): void {
		mutations.forEach((mutation) => {
			if (mutation.type === "attributes" || mutation.type === "childList") {
				const target = mutation.target as HTMLElement;
				const key = this.getElementKey(target);
				const rect = this.options.rectProvider ? this.options.rectProvider(target) : target.getBoundingClientRect();
				const size = BigInt(Math.round(rect.height));
				const offset = BigInt(Math.round(rect.top));
				const existingItem = this.ctx.manager.getItem(key);
				if (
					existingItem === undefined ||
					this.ctx.manager.getItemSize(existingItem) !== size ||
					this.ctx.manager.getItemOffset(existingItem) !== offset
				) {
					this.ctx.manager.updateItem(key, size, offset);
					this.emit("updated", target);
				}
			}
		});
		this.updateDisplay();
	}

	attachObservers(): void {
		this.#observer.disconnect();
		this.ctx.elements.forEach((el) => {
			if (this.options.dontVirtualizeIf?.(el)) return;
			this.#observer.observe(el, { attributes: true, childList: true, subtree: true });
		});
	}

	cleanObservers(): void {
		this.#observer.disconnect();
		this.attachObservers();
	}

	enqueueIdleTask(callback: () => void): void {
		if ("requestIdleCallback" in window) {
			if (this.#idleCallbackId !== null) {
				cancelIdleCallback(this.#idleCallbackId);
			}
			this.#idleCallbackId = requestIdleCallback(callback, { timeout: 500 });
		} else {
			setTimeout(callback, 500 * Math.random());
		}
	}

	updateDisplay(): void {
		// Disconnect internal observers.
		this.#observer.disconnect();
		if (this.#targetObserver) {
			this.#targetObserver.disconnect();
		}

		let topPadding = 0n;
		let bottomPadding = 0n;

		// Process each element with its index.
		this.ctx.elements.forEach((el, index) => {
			// Set the virtualizer-index attribute
			el.setAttribute("virtualizer-index", index.toString());

			const key = this.getElementKey(el);
			const itemData = this.ctx.manager.getItem(key);
			if (itemData === undefined) return;

			let newState: "visible" | "invisible" | "hidden";
			if (this.ctx.manager.isItemVisible(itemData)) {
				newState = "visible";
			} else if (this.ctx.manager.isItemRenderable(itemData)) {
				newState = "invisible";
			} else {
				newState = "hidden";
			}

				// If removeElementWhenHidden is enabled, remove or reattach element based on state.
				if (this.options.removeElementWhenHidden) {
					if (newState === "hidden" && el.parentElement) {
						el.remove();
						// Store removed element.
						this._removedElementMap.set(key, el);
						// Skip further processing for hidden elements.
						return;
					} else if (newState !== "hidden" && !el.parentElement && this.ctx.target) {
						// Reattach element at the proper position using its virtualizer-index.
						const target = this.ctx.target;
						const children = Array.from(target.children);
						let inserted = false;
						for (const child of children) {
							const childIndex = parseInt(child.getAttribute("virtualizer-index") || "0", 10);
							if (childIndex > index) {
								target.insertBefore(el, child);
								inserted = true;
								break;
							}
						}
						if (!inserted) {
							target.appendChild(el);
						}
						this._removedElementMap.delete(key);
					}
				}

			if (el.dataset.virtualState !== newState) {
				el.classList.remove(`virtualizer-${el.dataset.virtualState}`);
				el.dataset.virtualState = newState;
				if (newState === "visible") {
					this.emit("visible", el);
					this.emit("rendered", el);
				} else if (newState === "invisible") {
					this.emit("rendered", el);
				} else {
					this.emit("hidden", el);
				}
			}
			el.classList.add(`virtualizer-${newState}`);
			el.style.transform = "";
		});

		// ...existing code to compute topPadding and bottomPadding...
		const firstNonHiddenElementIndex = this.ctx.elements.findIndex(
			(el) => el.dataset.virtualState !== "hidden"
		);
		const lastNonHiddenElementIndex = this.ctx.elements.findLastIndex(
			(el) => el.dataset.virtualState !== "hidden"
		);
		if (firstNonHiddenElementIndex > 0) {
			const el = this.ctx.elements[firstNonHiddenElementIndex];
			const itemData = this.ctx.manager.getItem(this.getElementKey(el)) ?? 0n;
			topPadding = this.ctx.manager.getItemOffset(itemData);
		}
		if (lastNonHiddenElementIndex !== -1 && lastNonHiddenElementIndex < this.ctx.elements.length - 1) {
			const el = this.ctx.elements[lastNonHiddenElementIndex];
			const lastEl = this.ctx.elements[this.ctx.elements.length - 1];
			const itemData = this.ctx.manager.getItem(this.getElementKey(el)) ?? 0n;
			const lastItemData = this.ctx.manager.getItem(this.getElementKey(lastEl)) ?? 0n;
			bottomPadding = (
				this.ctx.manager.getItemOffset(lastItemData) +
				this.ctx.manager.getItemSize(lastItemData) -
				this.ctx.manager.getItemOffset(itemData) -
				this.ctx.manager.getItemSize(itemData)
			);
		}
		if (this.ctx.target) {
			this.ctx.target.style.paddingTop = topPadding.toString() + "px";
			this.ctx.target.style.paddingBottom = bottomPadding.toString() + "px";
		}

		this.attachObservers();

		// Reattach the target observer if a target exists.
		if (this.ctx.target && this.#targetObserver) {
			this.#targetObserver.observe(this.ctx.target, { childList: true });
		}
	}

	getElementKey(el: HTMLElement): string {
		if (!el.dataset.virtualizationKey) {
			el.dataset.virtualizationKey = crypto.randomUUID();
		}
		return el.dataset.virtualizationKey;
	}

	setCursorOffset(offset: bigint): void {
		this.ctx.manager.cursor.offset = offset;
		this.updateDisplay();
	}

	stop(): void {
		clearInterval(this.#contextTimer);
		clearInterval(this.#garbageTimer);
		this.#observer.disconnect();
		if (this.#targetObserver) this.#targetObserver.disconnect();
		if (!this.options.disableScrollCursor && this._scrollElem && this._boundScrollListener) {
			this._scrollElem.removeEventListener("scroll", this._boundScrollListener);
		}
	}

	private throttle(fn: (...args: any[]) => void, delay: number): () => void {
		let lastCall = 0;
		return (...args: any[]) => {
			const now = Date.now();
			if (now - lastCall >= delay) {
				lastCall = now;
				fn(...args);
			}
		};
	}
}

export function virtualizer(target: HTMLElement | string, options?: Omit<VirtualizerOptions, "target">): Virtualizer
export function virtualizer(options: VirtualizerOptions): Virtualizer
export function virtualizer(targetOrOptions: HTMLElement | string | VirtualizerOptions, options?: Omit<VirtualizerOptions, "target">): Virtualizer {
	let virt: Virtualizer;

	if (targetOrOptions instanceof HTMLElement || typeof targetOrOptions === "string") {
		virt = new Virtualizer({ target: targetOrOptions, ...options });
	} else {
		virt = new Virtualizer(targetOrOptions);
	}

	virt.start()

	return virt
}
