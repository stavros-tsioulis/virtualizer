import { describe, it, after } from "node:test";
import assert from "node:assert";
import { Virtualizer } from "../src/virtualizer.js";
import { makeHtmlIntoNode } from "./util/html.js";
import "global-jsdom/register";

// Create a rectProvider that uses dataset values.
function rectProviderWithDataset(el: HTMLElement) {
  const height = Number(el.dataset.height);
  const offset = Number(el.dataset.offset);
  return {
    top: offset,
    left: 0,
    right: 0,
    bottom: offset + height,
    height,
    width: 0,
    x: 0,
    y: offset,
    toJSON: () => ""
  };
}

// Build a container using a static array of 50 heights.
function createVaryingContainer() {
  // Static array of 50 numbers (10 repetitions of the pattern [20,30,40,50,60])
  const staticHeights = [
    20, 30, 40, 50, 60,
    20, 30, 40, 50, 60,
    20, 30, 40, 50, 60,
    20, 30, 40, 50, 60,
    20, 30, 40, 50, 60,
    20, 30, 40, 50, 60,
    20, 30, 40, 50, 60,
    20, 30, 40, 50, 60,
    20, 30, 40, 50, 60,
    20, 30, 40, 50, 60
  ];
  let cumulativeOffset = 0;
  const items: { height: number; offset: number }[] = [];
  const itemsHtml: string[] = [];
  for (const [i, height] of staticHeights.entries()) {
    items.push({ height, offset: cumulativeOffset });
    itemsHtml.push(`<div data-height="${height}" data-offset="${cumulativeOffset}">Item ${i}</div>`);
    cumulativeOffset += height;
  }
  const html = `<div>${itemsHtml.join("")}</div>`;
  return { container: makeHtmlIntoNode(html), itemsMeta: items };
}

describe("Virtualizer with varying item sizes", () => {
  const virtualizers: Virtualizer[] = [];
  after(() => {
    for (const v of virtualizers) {
      v.stop();
    }
  });

  it("should correctly update virtual states when cursor changes", async () => {
    const { container, itemsMeta } = createVaryingContainer();
    const viewportSize = 300n;
    const virtualizer = new Virtualizer({
      target: container,
      cursor: { offset: 0n, size: viewportSize },
      renderWindow: 150n,
      visibleWindow: 100n,
      rectProvider: rectProviderWithDataset,
    });
    virtualizers.push(virtualizer);
    virtualizer.start();

    await new Promise(r => setTimeout(r, 50));

    // Check first item is visible.
    const children0 = container.children;
    assert.ok(children0.length > 0, "Container should have children");
    const first = children0[0] as HTMLElement;
    assert.strictEqual(first.classList.contains("virtualizer-visible"), true);

    // Now, move cursor to mid (using itemsMeta[25].offset).
    const midCursor = BigInt(Math.floor(itemsMeta[25].offset));
    virtualizer.setCursorOffset(midCursor);
    await new Promise(r => setTimeout(r, 50));

    // Calculate expected visible range.
    const cursorVal = itemsMeta[25].offset;
    const visibleWindow = 100; // from Virtualizer options
    const rangeStart = cursorVal - visibleWindow;
    const rangeEnd = cursorVal + Number(viewportSize) + visibleWindow;
    const expectedIndices = itemsMeta
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => 
         (item.offset + item.height > rangeStart) && (item.offset < rangeEnd)
      )
      .map(({ index }) => index);

    // For each expected index, ensure the corresponding element is rendered properly.
    for (const idx of expectedIndices) {
      const el = Array.from(container.children).find(child => {
        return child.getAttribute("virtualizer-index") === String(idx);
      }) as HTMLElement | undefined;
      assert.ok(
        el && (el.classList.contains("virtualizer-visible") || el.classList.contains("virtualizer-invisible")),
        `Item at index ${idx} should be rendered`
      );
    }

    // Move cursor near the end.
    const lastMeta = itemsMeta[itemsMeta.length - 1];
    virtualizer.setCursorOffset(BigInt(lastMeta.offset));
    await new Promise(r => setTimeout(r, 50));

    const childrenEnd = container.children;
    const lastEl = Array.from(childrenEnd).find(child => {
      return child.getAttribute("virtualizer-index") === String(itemsMeta.length - 1);
    }) as HTMLElement | undefined;
    if (lastEl) {
      assert.strictEqual(lastEl.classList.contains("virtualizer-visible"), true);
    }

    // Ensure container's padding computed.
    assert.ok(container.style.paddingTop !== "", "paddingTop should be computed");
    assert.ok(container.style.paddingBottom !== "", "paddingBottom should be computed");
  });
});
