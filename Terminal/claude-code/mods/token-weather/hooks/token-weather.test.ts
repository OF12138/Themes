import { test, expect, mock } from "claude-code/testing";

test("the chart draws on terminal and desktop", async ($, on) => {
  const list = [
    { tokens: 20000, window: 367000, percent: 5 },
    { tokens: 90000, window: 367000, percent: 25 },
  ];
  on("session.id", () => ({ value: "s1" }) as any);
  on("session.usage", () => ({ value: { context: { window: 400000 } } }) as any);
  mock.store(on, { readings: { sessionId: "s1", list } });
  on("session.start", (_$, e) => e as any);
  on("ui.render", ($, e) => $.ui.resolve(e).Text({ children: "hint" }) as any);
  await $.session.start({ cwd: "F:/", surface: "terminal", isInteractive: true, source: "startup" } as any);
  for (const surface of ["terminal", "desktop"] as const) {
    const component = surface === "terminal" ? "PromptHint" : "AbovePrompt";
    const props = surface === "terminal"
      ? { isDraft: false, isWorking: false, hint: "" }
      : { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 };
    const ui = await $.ui.mount({ plugin: "token-weather", surface, component, props } as any);
    const text = JSON.stringify(await ui.drawn());
    expect(text).toContain("of context");
    if (surface === "desktop") expect(text).toContain("100%");
    await ui.unmount();
  }
});
