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
	removeInnerHTMLWhenHidden?: boolean;
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
	private _removedContentMap: Map<string, string> = new Map();
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
					this._garbageCollectInnerHTML();
				}),
			10000,
		);
		// NEW: Only attach scroll listener if disableScrollCursor is not set.
		if (!this.options.disableScrollCursor) {
			this._boundScrollListener = this._onScroll.bind(this);
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

	// NEW: Scroll handler to update cursor offset.
	private _onScroll(): void {
		let scrollTop: number;
		if (this._scrollElem instanceof HTMLElement) {
			scrollTop = this._scrollElem.scrollTop;
		} else {
			scrollTop = window.scrollY;
		}
		this.setCursorOffset(BigInt(scrollTop));
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
		this.#observer.disconnect();

		// Pre-calculate heights for each element.
		const heights: bigint[] = this.ctx.elements.map((el) => {
			const key = this.getElementKey(el);
			const itemData = this.ctx.manager.getItem(key);
			return itemData !== undefined ? this.ctx.manager.getItemSize(itemData) : 0n;
		});

		let topPadding = 0n;
		let bottomPadding = 0n;
		let firstVisibleFound = false;
		let lastVisibleIndex = -1;

		// Process each element to update state and compute padding accumulations.
		this.ctx.elements.forEach((el, i) => {
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

			if (el.dataset.virtualState !== newState) {
				el.dataset.virtualState = newState;
				if (newState === "visible") {
					this.emit("visible", el);
					this.emit("rendered", el);
				} else if (newState === "invisible") {
					this.emit("rendered", el);
				} else {
					this.emit("hidden", el);
				}

				if (this.options.removeInnerHTMLWhenHidden) {
					if (newState === "hidden") {
						this._removedContentMap.set(key, el.innerHTML);
						el.innerHTML = "";
					} else {
						const removedContent = this._removedContentMap.get(key);
						if (removedContent) {
							el.innerHTML = removedContent;
							this._removedContentMap.delete(key);
						}
					}
				}
			}

			el.classList.add(`virtualizer-${newState}`);
			el.style.transform = "";

			if (!firstVisibleFound && newState === "visible") {
				firstVisibleFound = true;
			}
			if (!firstVisibleFound) {
				topPadding += heights[i];
			}
			if (newState === "visible") {
				lastVisibleIndex = i;
			}
		});

		for (let i = lastVisibleIndex + 1; i < this.ctx.elements.length; i++) {
			bottomPadding += heights[i];
		}
		if (this.ctx.target) {
			this.ctx.target.style.paddingTop = topPadding.toString() + "px";
			this.ctx.target.style.paddingBottom = bottomPadding.toString() + "px";
		}
		this.attachObservers();
	}

	private _garbageCollectInnerHTML(): void {
		const existingKeys = new Set(this.ctx.elements.map((el) => this.getElementKey(el)));
		for (const key of Array.from(this._removedContentMap.keys())) {
			if (!existingKeys.has(key)) {
				this._removedContentMap.delete(key);
			}
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
}
