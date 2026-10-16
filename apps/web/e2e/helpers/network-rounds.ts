// Allows response-driven query updates and rendering to enqueue the next round.
export const NETWORK_ROUND_SETTLE_MS = 150;

type RoundArrival<Token> = { token: Token; key: string; now: number };

export const createNetworkRoundController = <Token>() => {
  const held = new Map<Token, string>();
  const inFlight = new Set<Token>();
  const rounds: string[][] = [];
  let lastActivityAt = 0;
  let status: "measuring" | "loaded" = "measuring";

  return {
    arrive: ({ token, key, now }: RoundArrival<Token>) => {
      lastActivityAt = now;
      if (status === "loaded") {
        return;
      }
      held.set(token, key);
    },
    complete: (token: Token, now: number) => {
      // A request aborted while still held never reaches the network: drop it
      // so it neither counts as a round nor waits for a completion that has
      // already happened.
      if (held.delete(token)) {
        lastActivityAt = now;
        return;
      }
      if (!inFlight.delete(token)) {
        return;
      }
      lastActivityAt = now;
    },
    release: (now: number): Token[] => {
      if (
        status === "loaded" ||
        inFlight.size > 0 ||
        held.size === 0 ||
        now - lastActivityAt < NETWORK_ROUND_SETTLE_MS
      ) {
        return [];
      }
      const tokens = [...held.keys()];
      rounds.push([...held.values()]);
      for (const token of tokens) {
        inFlight.add(token);
      }
      held.clear();
      return tokens;
    },
    finish: () => {
      status = "loaded";
      held.clear();
      inFlight.clear();
    },
    get pending() {
      return held.size > 0 || inFlight.size > 0;
    },
    get loaded() {
      return status === "loaded";
    },
    get rounds() {
      return rounds.map((round) => [...round]);
    },
  };
};
