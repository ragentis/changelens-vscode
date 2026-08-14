import { expect, test } from "vitest";
import { FileWorkQueue } from "../src/model/fileWork";
import { deferred } from "./helpers/async";

const WORK_FAILED = new Error("work failed");

test("a settled queue stops being remembered", async () => {
  const queue = new FileWorkQueue();

  await queue.enqueue("a", () => undefined);
  await queue.drainAll();

  expect(queue.outstanding).toBe(0);
});

test("work queued for one file runs in order", async () => {
  const queue = new FileWorkQueue();
  const order: string[] = [];
  const first = deferred();

  const one = queue.enqueue("a", async () => {
    await first.promise;
    order.push("one");
  });
  const two = queue.enqueue("a", () => {
    order.push("two");
  });

  first.resolve();
  await Promise.all([one, two]);
  expect(order).toEqual(["one", "two"]);
  expect(queue.outstanding).toBe(0);
});

test("a failed item neither stalls the next one nor strands its queue", async () => {
  const queue = new FileWorkQueue();
  const failing = deferred();
  let ran = false;

  const one = queue.enqueue("a", () => failing.promise);
  const two = queue.enqueue("a", () => {
    ran = true;
  });

  failing.reject(WORK_FAILED);
  await expect(one).rejects.toThrow("work failed");
  await two;

  expect(ran).toBe(true);
  expect(queue.outstanding).toBe(0);
});

test("joined work is drained alongside the file queues", async () => {
  const queue = new FileWorkQueue();
  const held = deferred();
  let finished = false;

  const joined = queue.join(
    (async () => {
      await held.promise;
      finished = true;
    })(),
  );
  expect(queue.outstanding).toBe(1);

  const drained = queue.drainAll();
  held.resolve();
  await drained;

  expect(finished).toBe(true);
  await joined;
  expect(queue.outstanding).toBe(0);
});

test("joined work that fails still reaches its caller and clears", async () => {
  const queue = new FileWorkQueue();

  const joined = queue.join(Promise.reject(new Error("nope")));
  await expect(joined).rejects.toThrow("nope");
  await queue.drainAll();

  expect(queue.outstanding).toBe(0);
});

test("draining the file queues ignores joined work, so a capture can drain from inside one", async () => {
  const queue = new FileWorkQueue();
  const held = deferred();

  void queue.join(held.promise);
  await queue.drainFiles();

  expect(queue.outstanding).toBe(1);
  held.resolve();
});
