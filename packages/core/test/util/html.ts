export function makeHtmlIntoNode(html: string) {
	const domParser = new DOMParser();
	const doc = domParser.parseFromString(html, "text/html");
	return doc.body.firstElementChild as HTMLElement;
}
