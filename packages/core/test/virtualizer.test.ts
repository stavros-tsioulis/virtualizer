import { after, describe, it } from "node:test";
import assert from "node:assert";
import { Virtualizer } from "../src/virtualizer.js";
import { makeHtmlIntoNode } from "./util/html.js";
import "global-jsdom/register";

function rectProviderWithDataset(element: HTMLElement) {
	const height = Number(element.dataset.height);
	const offset = Number(element.dataset.offset);
	return {
		bottom: offset + height,
		height,
		left: 0,
		right: 0,
		toJSON: () => "",
		top: offset,
		width: 0,
		x: 0,
		y: offset,
	};
}

function createVirtualizedTree(items: { height: number; offset: number }[]) {
	return makeHtmlIntoNode(`
    <div>
      ${items
				.map(
					(item) => `
        <div data-height="${item.height}" data-offset="${item.offset}"></div>
      `,
				)
				.join("")}
    </div>
  `);
}

describe("Virtualizer", () => {
	const virtualizers: Virtualizer[] = [];

	after(() => {
		for (const virtualizer of virtualizers) {
			virtualizer.stop();
		}
	});

	it("should properly virtualize items", async () => {
		const container = createVirtualizedTree([
			{ height: 100, offset: 0 },
			{ height: 200, offset: 100 },
			{ height: 300, offset: 300 },
			{ height: 400, offset: 600 },
			{ height: 500, offset: 1000 },
		]);

		const virtualizer = new Virtualizer({
			target: container,
			cursor: { size: 200n, offset: 0n },
			renderWindow: 400n,
			visibleWindow: 200n,
			rectProvider: rectProviderWithDataset,
		});

		virtualizers.push(virtualizer);
		virtualizer.start();

		const [first, second, third, fourth, fifth] = (virtualizer.ctx.target?.children ?? []) as HTMLElement[];

		assert.strictEqual(first.classList.contains("virtualizer-visible"), true);
		assert.strictEqual(second.classList.contains("virtualizer-visible"), true);
		assert.strictEqual(third.classList.contains("virtualizer-visible"), true);
		assert.strictEqual(fourth.classList.contains("virtualizer-invisible"), true);
		assert.strictEqual(fifth.classList.contains("virtualizer-hidden"), true);
		assert.strictEqual(container.style.paddingTop, "0px");
		assert.strictEqual(container.style.paddingBottom, "500px");

		virtualizer.setCursorOffset(600n);
		await new Promise((r) => setTimeout(r, 50));

		assert.strictEqual(first.classList.contains("virtualizer-hidden"), true);
		assert.strictEqual(second.classList.contains("virtualizer-invisible"), true);
		assert.strictEqual(third.classList.contains("virtualizer-visible"), true);
		assert.strictEqual(fourth.classList.contains("virtualizer-visible"), true);
		assert.strictEqual(fifth.classList.contains("virtualizer-visible"), true);
		assert.strictEqual(container.style.paddingTop, "100px");

		// increase the second item's height, pushing the rest down
		second.setAttribute("data-height", "300");
		third.setAttribute("data-offset", "400");
		fourth.setAttribute("data-offset", "700");
		fifth.setAttribute("data-offset", "1100");

		await new Promise((r) => setTimeout(r, 10));

		assert.strictEqual(second.classList.contains("virtualizer-visible"), true);
	});

	it("should integrate new elements added after activation", async () => {
		// Create a container with one initial element.
		const container = createVirtualizedTree([{ height: 100, offset: 0 }]);

		const virtualizer = new Virtualizer({
			target: container,
			cursor: { size: 200n, offset: 0n },
			renderWindow: 400n,
			visibleWindow: 200n,
			rectProvider: rectProviderWithDataset,
		});
		virtualizers.push(virtualizer);
		virtualizer.start();

		const initialChild = container.children[0] as HTMLElement;
		assert.ok(initialChild.dataset.virtualizationKey, "Initial element should have a virtualization key");

		// Insert a new element (simulate off-screen insertion)
		const newElement = document.createElement("div");
		newElement.setAttribute("data-height", "150");
		newElement.setAttribute("data-offset", "100");
		container.appendChild(newElement);

		// Wait briefly to allow mutation observers (via requestAnimationFrame) to process the new element.
		await new Promise((r) => setTimeout(r, 50));

		// The new element must be measured and integrated:
		assert.ok(newElement.dataset.virtualizationKey, "New element should get a virtualization key");
		assert.ok(
			newElement.classList.contains("virtualizer-item"),
			"New element should have a marker that it is virtualized",
		);
		assert.ok(newElement.classList.contains("virtualizer-visible"), "New element should be visible after measurement");

		// Insert a new element that will not be visible in the current viewport.
		const newElement2 = document.createElement("div");
		newElement2.setAttribute("data-height", "150");
		newElement2.setAttribute("data-offset", "700");
		container.appendChild(newElement2);

		// Wait briefly to allow mutation observers (via requestAnimationFrame) to process the new element.
		await new Promise((r) => setTimeout(r, 50));

		// The new element must be measured and integrated:
		assert.ok(newElement2.dataset.virtualizationKey, "New element should get a virtualization key");
		assert.ok(
			newElement2.classList.contains("virtualizer-item"),
			"New element should have a marker that it is virtualized",
		);
		assert.ok(newElement2.classList.contains("virtualizer-hidden"), "New element should be hidden after measurement");
	});

	it("should trigger events appropriately", async () => {
		// Create a container with two elements.
		const container = makeHtmlIntoNode(`
      <div>
        <div data-height="100" data-offset="0">Item 1</div>
        <div data-height="100" data-offset="100">Item 2</div>
      </div>
    `);

		let addedCount = 0,
			updatedCount = 0,
			hiddenCount = 0,
			visibleCount = 0,
			renderedCount = 0;

		const virtualizer = new Virtualizer({
			target: container,
			cursor: { size: 200n, offset: 0n },
			renderWindow: 150n,
			visibleWindow: 100n,
			rectProvider: rectProviderWithDataset,
		});

		virtualizers.push(virtualizer);

		// Register event listeners with exact increments.
		virtualizer.on("added", () => {
			addedCount++;
		});
		virtualizer.on("updated", () => {
			updatedCount++;
		});
		virtualizer.on("hidden", () => {
			hiddenCount++;
		});
		virtualizer.on("visible", () => {
			visibleCount++;
		});
		virtualizer.on("rendered", () => {
			renderedCount++;
		});

		virtualizer.start();

		// Allow initial processing
		await new Promise((r) => setTimeout(r, 50));

		// On start, both elements are new and become visible.
		// Expect "added" to be emitted for both (2 events).
		assert.strictEqual(addedCount, 2, "'added' count should be 2");
		assert.strictEqual(visibleCount, 2, "'visible' count should be 2");

		// Now, update first element attribute to trigger mutation.
		const first = container.children[0] as HTMLElement;
		const second = container.children[1] as HTMLElement;
		first.setAttribute("data-height", "120");
		second.setAttribute("data-offset", "120");
		await new Promise((r) => setTimeout(r, 50));
		// Expect at least one update event from mutated first element.
		assert.strictEqual(updatedCount, 2, "'updated' count should be 2");

		// Change cursor offset to 1000n so that first element becomes hidden.
		virtualizer.setCursorOffset(320n);
		await new Promise((r) => setTimeout(r, 50));
		// Now, first element's state changes from visible to hidden.
		// Only first element changes state.
		assert.strictEqual(hiddenCount, 1, "'hidden' count should be 1");

		// Revert cursor so that first element becomes visible again.
		virtualizer.setCursorOffset(0n);
		await new Promise((r) => setTimeout(r, 50));
		// When reverting, first element should emit "visible" and "rendered" event.
		assert.strictEqual(visibleCount, 3, "'visible' count should be 3");
		// Note: rendered is also emitted during visible state for our implementation.
		assert.strictEqual(renderedCount, 3, "'rendered' count should be 3");
		// Explanation: Initially, both elements became visible, so rendered emitted for both,
		// plus when first element came back from hidden it emitted rendered again.
	});
});
