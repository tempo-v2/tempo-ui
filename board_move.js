// Local visual projection. The server owns legal destinations and acceptance.
export function playBoardMove(board, uci) {
  return board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}

export function lineFromBoard(board) {
  const moves = board.history({ verbose: true });
  if (!moves.length) return null;
  return {
    start_fen: moves[0].before,
    moves: moves.map(({ before, san, after }) => {
      const [, turn, , , , number] = before.split(" ");
      return { notation: number + (turn === "b" ? "... " : ". ") + san, fen: after };
    }),
  };
}
