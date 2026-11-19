// Local visual projection. The server owns legal destinations and acceptance.
export function playBoardMove(board, uci) {
  return board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}
