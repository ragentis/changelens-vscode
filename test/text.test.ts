import { expect, test } from "vitest";
import { BOM, decodeUtf8, detectEol, splitLines, stripBom } from "../src/core/text";

test("detects the first line ending and defaults to LF", () => {
  expect(detectEol("one\ntwo")).toBe("\n");
  expect(detectEol("one\r\ntwo")).toBe("\r\n");
  expect(detectEol("one\rtwo")).toBe("\r");
  expect(detectEol("one\rtwo\nthree")).toBe("\r");
  expect(detectEol("one")).toBe("\n");
});

test("splits mixed line endings and preserves a trailing newline", () => {
  expect(splitLines("one\r\ntwo\rthree\n")).toEqual(["one", "two", "three", ""]);
});

test("removes only a leading byte order mark", () => {
  expect(stripBom(`${BOM}one`)).toBe("one");
  expect(stripBom(`one${BOM}`)).toBe(`one${BOM}`);
  expect(splitLines(`${BOM}one\n`)).toEqual(["one", ""]);
});

test("invalid UTF-8 is rejected instead of being decoded lossily", () => {
  // A lossy decode would put replacement characters in a baseline and then write them back to the
  // user's file on a revert.
  expect(decodeUtf8(new Uint8Array([0x68, 0x69]))).toBe("hi");
  expect(decodeUtf8(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
});

test("a byte order mark is preserved through decoding", () => {
  expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe(`${BOM}a`);
});
