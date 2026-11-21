import assert from "node:assert/strict";

export async function checkDesktopBoardLayout(page, label) {
  const board = page.getByRole("group", { name: label, exact: true });
  const square = board.locator("cg-board");
  await square.waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  // Board updates the square through ResizeObserver after a viewport change.
  await page.waitForFunction(node => {
    const start = document.querySelector(".tempo-nav")?.getBoundingClientRect().bottom ?? 0;
    const { top, height, bottom } = node.getBoundingClientRect();
    const usableHeight = innerHeight - start;
    const center = start + usableHeight / 2;
    return height > 0 && top >= start && bottom <= innerHeight &&
      Math.abs(top + height / 2 - center) <= usableHeight * 0.12;
  }, await square.elementHandle());
}

export async function checkDesktopBoardResize(page, label, minimumShrink = 24) {
  const board = page.getByRole("group", { name: label, exact: true });
  const square = board.locator("cg-board");
  const handle = board.locator(".tempo-board-resize-handle");
  await checkDesktopBoardLayout(page, label);
  await handle.waitFor();
  const before = await square.boundingBox();
  const viewport = page.viewportSize();
  const midpoint = box => box.y + box.height / 2;
  const start = await page.evaluate(() => document.querySelector(".tempo-nav")?.getBoundingClientRect().bottom ?? 0);
  const usableHeight = viewport.height - start;
  const center = start + usableHeight / 2;
  const checkCentered = box => assert(
    Math.abs(midpoint(box) - center) <= usableHeight * 0.12,
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
  assert(after.width <= before.width - minimumShrink, `${label} should shrink`);
  assert.equal(after.width, after.height);
  assert.equal(after.width % 8, 0);
  checkCentered(after);
  assert(Math.abs(midpoint(before) - midpoint(after)) <= 12, `${label} moved off its center`);
  assert.equal(await board.getAttribute("data-fen"), fen);
  return after.width;
}
