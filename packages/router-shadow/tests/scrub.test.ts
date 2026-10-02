import { expect, test } from "bun:test";
import { scrubSecrets } from "../src/scrub.js";

interface ScrubCase {
	name: string;
	input: string;
	expected: string;
}

const cases = JSON.parse(
	await Bun.file(new URL("./fixtures/scrub.json", import.meta.url)).text(),
) as ScrubCase[];

for (const c of cases) {
	test(`scrub: ${c.name}`, () => {
		expect(scrubSecrets(c.input)).toBe(c.expected);
	});
}
