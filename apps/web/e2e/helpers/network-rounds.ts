// Must exceed response-driven render latency so late siblings join the same round.
export const NETWORK_ROUND_SETTLE_MS = 500;

type RoundArrival<Token> = { token: Token; key: string; now: number };

export const createNetworkRoundController = <Token>() => {
  const requests = new Map<
    Token,
    { key: string; status: "in-flight" | "held" }
  >();
  const rounds: string[][] = [];
  let lastArrivalAt = 0;
  let status: "measuring" | "loaded" = "measuring";

  return {
    arrive: ({ token, key, now }: RoundArrival<Token>) => {
      if (status === "loaded") {
        return;
      }
      lastArrivalAt = now;
      requests.set(token, { key, status: "in-flight" });
    },
    complete: (token: Token) => {
      const request = requests.get(token);
      if (request) {
        requests.set(token, { key: request.key, status: "held" });
      }
    },
    abort: (token: Token) => {
      requests.delete(token);
    },
    release: (now: number): Token[] => {
      if (
        status === "loaded" ||
        requests.size === 0 ||
        now - lastArrivalAt < NETWORK_ROUND_SETTLE_MS ||
        [...requests.values()].some((request) => request.status === "in-flight")
      ) {
        return [];
      }
      const tokens = [...requests.keys()];
      rounds.push([...requests.values()].map(({ key }) => key));
      requests.clear();
      return tokens;
    },
    /** Reject incomplete measurements, while allowing held responses to drain. */
    finish: () => {
      const undrained = [...requests.values()].map(
        ({ key, status: state }) => `${key} (${state})`,
      );
      status = "loaded";
      requests.clear();
      if (undrained.length > 0) {
        throw new Error(
          `Network rounds did not drain before the measurement ended: ${String(undrained.length)} request(s) still held or in flight: ${undrained.join(", ")}`,
        );
      }
    },
    holds: (token: Token) => requests.has(token),
    get pending() {
      return requests.size > 0;
    },
    get loaded() {
      return status === "loaded";
    },
    get rounds() {
      return rounds.map((round) => [...round]);
    },
  };
};
