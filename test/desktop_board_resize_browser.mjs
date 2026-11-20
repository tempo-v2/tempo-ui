import assert from "node:assert/strict";

export async function checkDesktopBoardResize(page, label) {
  const board = page.getByRole("group", { name: label, exact: true });
  const square = board.locator("cg-board");
  const handle = board.locator(".tempo-board-resize-handle");
  await handle.waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  const before = await square.boundingBox();
  const viewport = page.viewportSize();
  const midpoint = box => box.y + box.height / 2;
  const center = viewport.height / 2;
  const checkCentered = box => assert(
    Math.abs(midpoint(box) - center) <= viewport.height * 0.12,
    `${label} midpoint ${midpoint(box)} is too far from ${center}`,
  );
  checkCentered(before);
  const corner = await handle.boundingBox();
  const x = corner.x + corner.width / 2;
  const y = corner.y + corner.height / 2;
  const fen = await board.getAttribute("data-fen");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 72, y - 36, { steps: 8 });
  await page.mouse.up();
  const after = await square.boundingBox();
  assert(after.width <= before.width - 24, `${label} should shrink`);
  assert.equal(after.width, after.height);
  assert.equal(after.width % 8, 0);
  checkCentered(after);
  assert(Math.abs(midpoint(before) - midpoint(after)) <= 12, `${label} moved off its center`);
  assert.equal(await board.getAttribute("data-fen"), fen);
  return after.width;
}
