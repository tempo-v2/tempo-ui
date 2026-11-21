import { object } from "./wire_values.js";

const SQUARE = /^[a-h][1-8]$/;
const ROLES = ["pawn", "knight", "bishop", "rook", "queen", "king"];

function subject(value) {
  object(value, ["square", "role", "color"], "tactic piece");
  const { square, role, color } = value;
  if (typeof square !== "string" || !SQUARE.test(square) ||
      !ROLES.includes(role) || !["white", "black"].includes(color)) {
    throw new TypeError("Invalid tactic piece");
  }
  return { square, role, color };
}

// A display-only extension may be dropped without rejecting the accepted answer.
export function readTacticExplanation(value) {
  const kind = value?.kind;
  try {
    switch (kind) {
      case "pin":
      case "pin_capture":
      case "skewer": {
        const keys = ["kind", "attacker", "front", "rear"];
        if (kind === "pin_capture") keys.push("captured");
        object(value, keys, "tactic ray");
        const ray = { kind, attacker: subject(value.attacker), front: subject(value.front), rear: subject(value.rear) };
        return kind === "pin_capture" ? { ...ray, captured: subject(value.captured) } : ray;
      }
      case "fork":
        object(value, ["kind", "attacker", "targets"], "fork");
        if (!Array.isArray(value.targets) || value.targets.length !== 2) return null;
        return { kind, attacker: subject(value.attacker), targets: value.targets.map(subject) };
      case "discovered_attack":
      case "discovered_check":
        object(value, ["kind", "attacker", "target"], "discovered attack");
        return { kind, attacker: subject(value.attacker), target: subject(value.target) };
      case "mate_in_one":
        object(value, ["kind", "king", "checkers"], "mate in one");
        if (!Array.isArray(value.checkers) || value.checkers.length === 0) return null;
        return { kind, king: subject(value.king), checkers: value.checkers.map(subject) };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function arrow(from, to) {
  return { orig: from.square, dest: to.square, brush: "green" };
}

function ring(piece) {
  return { orig: piece.square, brush: "green" };
}

function piece(subject) {
  return `the ${subject.role} on ${subject.square}`;
}

export function presentTacticExplanation(feedback) {
  const hint = feedback?.tactic_explanation;
  if (!hint) return null;
  const move = feedback.correction_san ?? feedback.correction_uci;
  const after = `After ${move},`;
  const { attacker, front, rear } = hint;
  switch (hint.kind) {
    case "pin":
      return {
        text: `${after} ${piece(attacker)} pins ${piece(front)}. Leaving the line would expose ${piece(rear)}.`,
        shapes: [arrow(attacker, rear), ring(front), ring(rear)],
      };
    case "pin_capture":
      return {
        text: `${move} captures ${piece(hint.captured)}. The ${front.role} on ${front.square} is pinned by ${piece(attacker)} and cannot recapture without exposing ${piece(rear)}.`,
        shapes: [arrow(attacker, rear), ring(front), ring(rear)],
      };
    case "skewer":
      return {
        text: `${after} ${piece(attacker)} skewers ${piece(front)} and ${piece(rear)}. Moving the front piece off the line exposes the piece behind it.`,
        shapes: [arrow(attacker, rear), ring(front), ring(rear)],
      };
    case "fork": {
      const [first, second] = hint.targets;
      return {
        text: `${after} ${piece(attacker)} forks ${piece(first)} and ${piece(second)}, attacking both at once.`,
        shapes: [arrow(attacker, first), arrow(attacker, second), ring(first), ring(second)],
      };
    }
    case "discovered_attack":
    case "discovered_check":
      return {
        text: `${after} the line opens for ${piece(attacker)} to ${hint.kind === "discovered_check" ? "check" : "attack"} ${piece(hint.target)}.`,
        shapes: [arrow(attacker, hint.target), ring(hint.target)],
      };
    case "mate_in_one":
      return {
        text: `${after} ${piece(hint.king)} is checkmated by ${hint.checkers.map(piece).join(" and ")}.`,
        shapes: [...hint.checkers.map(checker => arrow(checker, hint.king)), ring(hint.king)],
      };
    default:
      return null;
  }
}
