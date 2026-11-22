export function moveArrow(move, brush) {
  return {orig:move.slice(0,2), dest:move.slice(2,4), brush};
}
