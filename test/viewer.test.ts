import { describe, expect, test } from "bun:test";
import { decodeInputSequences } from "../src/viewer.ts";

describe("viewer input", () => {
	test("decodes coalesced escape sequences without exposing their bytes as commands", () => {
		expect(decodeInputSequences("\x1b[A\x1b[Bjj\x1b[5~")).toEqual({
			tokens: ["\x1b[A", "\x1b[B", "j", "j", "\x1b[5~"],
			remainder: "",
		});
	});

	test("keeps split escape sequences buffered until complete", () => {
		const partial = decodeInputSequences("\x1b[<64;12;");
		expect(partial).toEqual({ tokens: [], remainder: "\x1b[<64;12;" });
		expect(decodeInputSequences(`${partial.remainder}9M\x1bOA`)).toEqual({
			tokens: ["\x1b[<64;12;9M", "\x1bOA"],
			remainder: "",
		});
	});

	test("distinguishes a flushed Escape key from an incomplete control sequence", () => {
		expect(decodeInputSequences("\x1b", true)).toEqual({ tokens: ["\x1b"], remainder: "" });
		expect(decodeInputSequences("\x1b[<64;", true)).toEqual({ tokens: ["\x1b[<64;"], remainder: "" });
	});

	test("preserves complete Unicode input characters", () => {
		expect(decodeInputSequences("/café🙂\r").tokens).toEqual(["/", "c", "a", "f", "é", "🙂", "\r"]);
	});
});
