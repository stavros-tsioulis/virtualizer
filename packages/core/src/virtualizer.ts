import { EventEmitter } from "typed-events"

export type WasmModule = {
  get_item_indices_in_window(
    items: number,
    result: number,
    items_count: number,
    cursor_offset: number,
    cursor_size: number,
    window_size: number,
  ): number

  make_item(
    size: number,
    offset: number
  ): bigint

  get_top_padding(
    items: number,
    first_item_index: number
  ): number

  get_bottom_padding(
    items: number,
    total_items: number,
    last_item_index: number,
  ): number

  memory: WebAssembly.Memory
}

export type Cursor = {
	offset: number;
	size: number;
};

export type VirtualizerContextOptions = {
  target: HTMLElement | string;
  items?: HTMLElement[] | string;
}

export type VirtualizerCommonOptions = {
  wasm: WasmModule;
  cursor?: Cursor;
  renderWindow?: number;
  visibleWindow?: number;
  rectProvider?: (element: HTMLElement) => DOMRect;
}

export type StaticVirtualizerOptions = VirtualizerContextOptions & VirtualizerCommonOptions & {
  strategy: "static_height"
  size: number
}

export type AverageHeightApproximationVirtualizerOptions = VirtualizerContextOptions & VirtualizerCommonOptions & {
  strategy: "average_height_approximation"
  initialAverage?: number
}

export type FullyObservedListOptions = VirtualizerContextOptions & VirtualizerCommonOptions & {
  strategy: "fully_observed_list"
}

export type VirtualizerOptions =
  | StaticVirtualizerOptions
  | AverageHeightApproximationVirtualizerOptions
  | FullyObservedListOptions

export class VirtualizerContext {
  protected _resolvedTarget: HTMLElement | undefined = undefined
  protected _resolvedItems: HTMLElement[] | undefined = undefined

  constructor(
    protected options: VirtualizerContextOptions
  ) {}

  public get resolvedTarget() {
    if (this._resolvedTarget) return this._resolvedTarget
    return this._resolvedTarget = this.resolveTarget()
  }

  public get resolvedItems() {
    if (this._resolvedItems) return this._resolvedItems
    return this._resolvedItems = this.resolveItems()
  }

  protected resolveTarget() {
    const target = typeof this.options.target === 'string'
      ? document.querySelector(this.options.target) as HTMLElement | null
      : this.options.target
    if (!target) throw new Error("Could not resolve target for virtualizer")
    return target
  }

  protected resolveItems() {
    return this.options.items === undefined
      ? this.resolveItemsWithTargetChildren()
      : typeof this.options.items === 'string'
        ? this.resolveItemsWithSelector(this.options.items)
        : this.options.items
  }

  protected resolveItemsWithSelector(selector: string) {
    if (!this.resolvedTarget) return []
    return [...this.resolvedTarget.querySelectorAll(selector)] as HTMLElement[]
  }

  protected resolveItemsWithTargetChildren() {
    if (!this.resolvedTarget) return []
    return [...this.resolvedTarget.children].filter((c): c is HTMLElement => c instanceof HTMLElement)
  }
}

export class VirtualizerScrollEmitter extends EventEmitter<{
  scroll: [offset: number]
}> {
  protected _boundListener: typeof this._onScroll

  constructor(
    protected target: HTMLElement | Window
  ) {
    super()
    this._boundListener = throttle(this._onScroll.bind(this), 50)
  }

  public start() {
    this.target.addEventListener('scroll', this._boundListener)
  }

  public stop() {
  this.target.removeEventListener('scroll', this._boundListener)
  }

  protected _onScroll() {
    const scroll = this.target instanceof HTMLElement ? this.target.scrollTop : this.target.scrollY
    this.emit('scroll', scroll)
  }
}

export abstract class Virtualizer extends EventEmitter<{
  started: []
  stopped: []
}> {
  constructor(
    protected readonly ctx: VirtualizerContext,
    protected readonly scrollEmitter: VirtualizerScrollEmitter,
    protected readonly currentCursor: Cursor,
  ) {
    super()
  }

  public start() {
    this.scrollEmitter.on('scroll', scroll => {
      this.currentCursor.offset = scroll
      this.updateItems()
    })
    this.emit('started')
  }

  public stop() {
    this.scrollEmitter.removeAllListeners('scroll')
    this.emit('stopped')
  }

  protected abstract updateItems(): void

  protected setItemsStateInRange(start: number, end: number, state: 'visible' | 'rendered' | 'hidden') {
    for (let i = start; i < end; ++i) {
      const item = this.ctx.resolvedItems[i]
      if (!item) break
      item.classList.remove('virtualizer-hidden', 'virtualizer-visible', 'virtualizer-rendered')
      item.classList.add(`virtualizer-${state}`)
    }
  }

  protected clearAllItemsClasses() {
    for (let i = 0; i < this.ctx.resolvedItems.length; ++i) {
      const item = this.ctx.resolvedItems[i]
      if (!item) break
      item.classList.remove('virtualizer-hidden', 'virtualizer-visible', 'virtualizer-rendered')
    }
  }

  protected getRectSizeField(rect: DOMRect) {
    return rect.height
  }

  protected getRectOffsetField(rect: DOMRect) {
    return rect.y
  }
}

export class StaticVirtualizer extends Virtualizer {
  protected _previouslyNonHiddenItems: [start: number, end: number] = [0, 0]

  constructor(
    protected options: StaticVirtualizerOptions,
  ) {
    const ctx = new VirtualizerContext(options)
    const scrollEmitter = new VirtualizerScrollEmitter(ctx.resolvedTarget)
    const currentCursor = {
      offset: options.cursor?.offset ?? 0,
      size: options.cursor?.size ?? 1024
    }

    super(ctx, scrollEmitter, currentCursor)
  }

  protected updateItems() {
    if (this.ctx.resolvedItems.length === 0) return

    const {
      renderedItemsStart,
      visibleItemsStart,
      visibleItemsEnd,
      renderedItemsEnd,
    } = this.getItemsMetadata(this.currentCursor, this.itemSize)

    this.setItemsStateInRange(this._previouslyNonHiddenItems[0], this._previouslyNonHiddenItems[1], 'hidden')
    this.setItemsStateInRange(renderedItemsStart, renderedItemsEnd, 'rendered')
    this.setItemsStateInRange(visibleItemsStart, visibleItemsEnd, 'visible')
    this._previouslyNonHiddenItems[0] = renderedItemsStart
    this._previouslyNonHiddenItems[1] = renderedItemsEnd
  }

  protected getItemsMetadata(cursor: Cursor, itemSize: number) {
    if (itemSize === 0) throw new Error("Cannot calculate with itemSize being 0")

    const visibleWindow = this.options.visibleWindow ?? 0
    const renderWindow = this.options.renderWindow ?? 0

    const totalItemsInVisibleWindow = Math.floor((cursor.offset + cursor.size + visibleWindow) / itemSize)
    const totalItemsInRenderWindow = Math.floor((cursor.offset + cursor.size + renderWindow) / itemSize)

    const renderedItemsStart = Math.floor((cursor.offset - renderWindow) / itemSize)
    const visibleItemsStart = Math.floor((cursor.offset - visibleWindow) / itemSize)
    const visibleItemsEnd = visibleItemsStart + totalItemsInVisibleWindow
    const renderedItemsEnd = renderedItemsStart + totalItemsInRenderWindow

    return {
      renderedItemsStart,
      visibleItemsStart,
      visibleItemsEnd,
      renderedItemsEnd,
    }
  }

  protected get itemSize() {
    return this.options.size
  }
}

export class AverageHeightApproximationVirtualizer extends Virtualizer {
  protected _previouslyNonHiddenItems: [start: number, end: number] = [0, 0]

  protected currentAverage: number;
  protected totalItems = 0;

  constructor(
    protected options: AverageHeightApproximationVirtualizerOptions
  ) {
    const ctx = new VirtualizerContext(options)
    const scrollEmitter = new VirtualizerScrollEmitter(ctx.resolvedTarget)
    const currentCursor = {
      offset: options.cursor?.offset ?? 0,
      size: options.cursor?.size ?? 1024
    }
    super(ctx, scrollEmitter, currentCursor)

    this.currentAverage = options.initialAverage ?? 0
  }

  protected updateItems(): void {
    if (this.currentAverage === 0 || this.ctx.resolvedItems.length === 0) return

    const firstApproximatedRenderedItem = this.getFirstRenderedItemIndexWithAverage(this.currentCursor, this.currentAverage)
    const firstApproximatedVisibleItem = this.getFirstRenderedItemIndexWithAverage(this.currentCursor, this.currentAverage)

    const {
      firstIndex: firstRenderedIndex,
      lastIndex: lastRenderedIndex,
    } = this.getFirstAndLastIndexOfItemsInWindow(
      firstApproximatedRenderedItem,
      this.options.renderWindow ?? 0
    )

    const {
      firstIndex: firstVisibleIndex,
      lastIndex: lastVisibleIndex,
    } = this.getFirstAndLastIndexOfItemsInWindow(
      firstApproximatedVisibleItem,
      this.options.visibleWindow ?? 0
    )
  }

  protected getFirstRenderedItemIndexWithAverage(cursor: Cursor, itemSize: number) {
    const renderWindow = this.options.renderWindow ?? 0
    return Math.floor((cursor.offset - renderWindow) / itemSize)
  }

  protected getFirstVisibleItemIndexWithAverage(cursor: Cursor, itemSize: number) {
    const visibleWindow = this.options.visibleWindow ?? 0
    return Math.floor((cursor.offset - visibleWindow) / itemSize)
  }

  protected getFirstAndLastIndexOfItemsInWindow(startApproxIndex: number, windowSize: number) {
    // Find the approximated element's index (or last element if the index exceeds it)
    const index = Math.max(startApproxIndex, this.ctx.resolvedItems.length - 1)
    const el = this.ctx.resolvedItems[index]

    // Get the element's rect and check if it should be in the window
    const approxItemRect = this.getElementRect(el)
    const isItemRendered = this.isItemInWindow(approxItemRect.y, approxItemRect.height, windowSize)

    // Now, we begin searching around the element to see for more items in the window
    let firstIndex = 0;
    let lastIndex = 0;
    if (isItemRendered) {
      // If the item is in, then we search upwards, and stop when an element is outside
      firstIndex = index
      for (let i = index; i >= 0; --i) {
        if (this.isElementInWindow(this.ctx.resolvedItems[i], windowSize)) {
          firstIndex = i
        } else {
          break
        }
      }
    } else {
      // If not, then we try to find the first item in window downwards
      for (let i = index; i < this.ctx.resolvedItems.length; ++i) {
        if (this.isElementInWindow(this.ctx.resolvedItems[i], windowSize)) {
          firstIndex = i
          break
        }
      }
    }

    // Then, we search for the last item in the window
    for (let i = firstIndex; i < this.ctx.resolvedItems.length; ++i) {
      if (this.isElementInWindow(this.ctx.resolvedItems[i], windowSize)) {
        lastIndex = i
      } else {
        break
      }
    }

    return {
      firstIndex,
      lastIndex,
    }
  }

  protected isElementInWindow(element: HTMLElement, windowSize: number) {
    const rect = this.getElementRect(element)
    return this.isItemInWindow(this.getRectOffsetField(rect), this.getRectSizeField(rect), windowSize)
  }

  protected isItemInWindow(
    offset: number,
    size: number,
    windowSize: number,
  ) {
    return (
      offset <= this.currentCursor.offset + this.currentCursor.size + windowSize &&
      offset + size >= this.currentCursor.offset - windowSize
    )
  }

  protected getElementRect(element: HTMLElement) {
    const rect = this.options.rectProvider?.(element) ?? element.getBoundingClientRect()
    this.adjustAverage(this.getRectSizeField(rect))
    return rect
  }

  /**
   * Adjust the current average by replacing an item's value in-place
   */
  protected adjustAverage(value: number) {
    if (this.totalItems === 0) throw new Error("Cannot adjust an average with 0 items")
    this.currentAverage += (value - this.currentAverage) / (this.totalItems)
  }

  /**
   * Update the current average when adding a new item
   */
  protected addToAverage(value: number) {
    this.currentAverage += (value - this.currentAverage) / (++this.totalItems)
  }
}

export class FullyObservedListVirtualizer extends Virtualizer {
  protected _previouslyNonHiddenItems: [start: number, end: number] = [0, 0]
  protected _deactivateObserversTimer: NodeJS.Timeout | null = null

  protected targetObserver: MutationObserver | null = null
  protected itemsSizeObserver: ResizeObserver | null = null

  protected targetObserverDisabled = false
  protected itemsSizeObserverDisabled = false

  protected itemSizes: bigint[] = []

  constructor(
    protected options: FullyObservedListOptions
  ) {
    const ctx = new VirtualizerContext(options)
    const scrollEmitter = new VirtualizerScrollEmitter(window)
    const currentCursor = {
      offset: options.cursor?.offset ?? 0,
      size: options.cursor?.size ?? 1024
    }

    super(ctx, scrollEmitter, currentCursor)

    this.on('started', () => {
      this.attachObserverToTarget()
      this.attachObserverToItemsSize()
      this.initClassesAndSizes()
    })

    this.on('stopped', () => {
      this.targetObserver?.disconnect()
      this.itemsSizeObserver?.disconnect()
    })
  }

  protected updateItems(): void {
    this.deactivateObserversFor(50)

    const {
      start: renderedItemsStart,
      end: renderedItemsEnd,
    } = this.getItemsInWindow(this.options.renderWindow ?? 0)

    const {
      start: visibleItemsStart,
      end: visibleItemsEnd,
    } = this.getItemsInWindow(this.options.renderWindow ?? 0)

    this.setItemsStateInRange(this._previouslyNonHiddenItems[0], this._previouslyNonHiddenItems[1], 'hidden')
    this.setItemsStateInRange(renderedItemsStart, renderedItemsEnd, 'rendered')
    this.setItemsStateInRange(visibleItemsStart, visibleItemsEnd, 'visible')

    this.ctx.resolvedTarget.style.paddingTop = `${this.getTopPadding(renderedItemsStart)}px`
    this.ctx.resolvedTarget.style.paddingBottom = `${this.getBottomPadding(renderedItemsEnd)}px`
  }

  protected getItemsInWindow(windowSize: number) {
    const input = new BigUint64Array(this.options.wasm.memory.buffer, 0, this.itemSizes.length)
    input.set(this.itemSizes)

    const output = new Uint32Array(this.options.wasm.memory.buffer, input.length * BigUint64Array.BYTES_PER_ELEMENT, this.itemSizes.length)

    const len = this.options.wasm.get_item_indices_in_window(
      input.byteOffset,
      output.byteOffset,
      input.length,
      this.currentCursor.offset,
      this.currentCursor.size,
      windowSize
    )

    if (len === 0) return { start: 0, end: 0 }

    const arrayed = Array.from(output)

    return {
      start: arrayed[0],
      end: arrayed[len - 1],
    }
  }

  protected getTopPadding(firstItemIndex: number) {
    const input = new BigUint64Array(this.options.wasm.memory.buffer, 0, this.itemSizes.length)
    input.set(this.itemSizes)

    return this.options.wasm.get_top_padding(input.byteOffset, firstItemIndex)
  }

  protected getBottomPadding(lastItemIndex: number) {
    const input = new BigUint64Array(this.options.wasm.memory.buffer, 0, this.itemSizes.length)
    input.set(this.itemSizes)

    return this.options.wasm.get_bottom_padding(input.byteOffset, input.length, lastItemIndex)
  }

  protected resetItemSizes() {
    this.itemSizes.splice(0, this.itemSizes.length)
    this.ctx.resolvedItems.forEach((item, index) => {
      const rect = this.getElementRect(item)
      item.classList.add('virtualizer-item')
      item.setAttribute('virtualizer-index', index.toString())
      this.itemSizes.push(this.options.wasm.make_item(this.getRectSizeField(rect), this.getRectOffsetField(rect)))
    })
  }

  protected async initClassesAndSizes() {
    this.clearAllItemsClasses()
    await this.nextTick()
    this.resetItemSizes()
    this.updateItems()
  }

  protected attachObserverToTarget() {
    if (this.targetObserver) this.targetObserver.disconnect()

    this.targetObserver = new MutationObserver(async () => {
      if (this.targetObserverDisabled) return
      await this.initClassesAndSizes()
    })

    this.targetObserver.observe(this.ctx.resolvedTarget, { childList: true })
  }

  protected attachObserverToItemsSize() {
    if (this.itemsSizeObserver) this.itemsSizeObserver.disconnect()

    this.itemsSizeObserver = new ResizeObserver((entries) => {
      entries.forEach(entry => {
        const index = this.getElementIndex(entry.target as HTMLElement)
        if (index === undefined) return

        const rect = entry.contentRect
        this.itemSizes[index] = this.options.wasm.make_item(this.getRectSizeField(rect), this.getRectOffsetField(rect))
      })
    })
  }

  protected getElementRect(element: HTMLElement) {
    const rect = this.options.rectProvider?.(element) ?? element.getBoundingClientRect()
    return rect
  }

  protected getElementIndex(element: HTMLElement) {
    const indexAttr = Number(element.getAttribute('virtualizer-index') ?? undefined)
    if (Number.isNaN(indexAttr)) return
    return indexAttr
  }

  protected nextTick() {
    return new Promise(r => requestAnimationFrame(r))
  }

  protected deactivateObserversFor(ms: number) {
    this.targetObserverDisabled = true
    this.itemsSizeObserverDisabled = true

    if (this._deactivateObserversTimer) clearTimeout(this._deactivateObserversTimer)
    this._deactivateObserversTimer = setTimeout(() => {
      this.targetObserverDisabled = false
      this.itemsSizeObserverDisabled = false
    }, ms);
  }
}

function throttle<T extends (...args: any[]) => any>(fn: T, ms: number) {
  let timer: NodeJS.Timeout | null = null
  let deferred = false
  let latestArgs = [] as unknown as Parameters<T>

  return (...args: Parameters<T>) => {
    latestArgs = args

    if (!timer) {
      fn(...latestArgs)
      deferred = false
    } else {
      latestArgs = args
      deferred = true
    }

    timer = setTimeout(() => {
      if (deferred) {
        fn(...latestArgs)
      }

      timer = null
      deferred = false
    }, ms);
  }
}

export type VirtualizerFn = ((options: VirtualizerOptions) => Promise<Virtualizer>) & {
  setWasmUrl(url: string): void
}

let wasmUrl = ''

export async function virtualizer(options: Omit<VirtualizerOptions, "wasm">) {
  if (!wasmUrl) throw new Error("No wasm URL set!")

  const wasm = await WebAssembly.instantiateStreaming(fetch(wasmUrl))
  const finalOptions = {
    ...options,
    wasm: wasm.instance.exports as WasmModule
  } as VirtualizerOptions

  switch (finalOptions.strategy) {
    case 'average_height_approximation': return new AverageHeightApproximationVirtualizer(finalOptions)
    case 'fully_observed_list': return new FullyObservedListVirtualizer(finalOptions)
    case 'static_height': return new StaticVirtualizer(finalOptions)
    default: throw new Error("Invalid virtualizer strategy")
  }
}

export function setWasmUrl(url: string) {
  wasmUrl = url
}
