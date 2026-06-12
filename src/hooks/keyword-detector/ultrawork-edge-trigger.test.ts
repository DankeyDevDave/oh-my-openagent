import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { createKeywordDetectorHook } from "./index"
import { _resetForTesting, setMainSession } from "../../features/claude-code-session-state"

type StartLoopCall = {
  sessionID: string
  prompt: string
  options: Record<string, unknown>
}

function createMockPluginInput(toastCalls: string[] = []) {
  return {
    client: {
      tui: {
        showToast: async (opts: { body: { title: string } }) => {
          toastCalls.push(opts.body.title)
        },
      },
    },
  } as any
}

function createMockRalphLoop(startLoopCalls: StartLoopCall[]) {
  return {
    startLoop: (sessionID: string, prompt: string, options?: Record<string, unknown>): boolean => {
      startLoopCalls.push({ sessionID, prompt, options: options ?? {} })
      return true
    },
  }
}

describe("keyword-detector ultrawork edge trigger", () => {
  beforeEach(() => {
    _resetForTesting()
    setMainSession("main-session")
  })

  afterEach(() => {
    _resetForTesting()
  })

  test("#given greeting text before ulw and surrounding whitespace #when chat.message fires #then ultrawork still activates", async () => {
    // given
    const toastCalls: string[] = []
    const startLoopCalls: StartLoopCall[] = []
    const hook = createKeywordDetectorHook(
      createMockPluginInput(toastCalls),
      undefined,
      createMockRalphLoop(startLoopCalls),
    )
    const output = {
      message: {} as Record<string, unknown>,
      parts: [{ type: "text", text: " hi there ulw " }],
    }

    // when
    await hook["chat.message"]({ sessionID: "main-session", agent: "sisyphus" }, output)

    // then
    expect(toastCalls).toContain("Ultrawork Mode Activated")
    expect(startLoopCalls).toHaveLength(1)
    expect(startLoopCalls[0]).toEqual({
      sessionID: "main-session",
      prompt: "Complete the task as instructed",
      options: {
        ultrawork: true,
        maxIterations: undefined,
        completionPromise: undefined,
        strategy: undefined,
      },
    })
    expect(output.parts[0]?.text).toContain("ULTRAWORK MODE ENABLED!")
    expect(output.parts[0]?.text).toContain(" hi there ulw ")
  })

  test("#given ulw mentioned in the middle of a sentence #when chat.message fires #then ultrawork stays disabled", async () => {
    // given
    const toastCalls: string[] = []
    const startLoopCalls: StartLoopCall[] = []
    const hook = createKeywordDetectorHook(
      createMockPluginInput(toastCalls),
      undefined,
      createMockRalphLoop(startLoopCalls),
    )
    const output = {
      message: {} as Record<string, unknown>,
      parts: [{ type: "text", text: "I think ulw is cool" }],
    }

    // when
    await hook["chat.message"]({ sessionID: "main-session", agent: "sisyphus" }, output)

    // then
    expect(toastCalls).not.toContain("Ultrawork Mode Activated")
    expect(startLoopCalls).toHaveLength(0)
    expect(output.parts[0]?.text).toBe("I think ulw is cool")
  })

  test("#given trailing ultrawork reference without punctuation #when chat.message fires #then ultrawork stays disabled", async () => {
    // given
    const toastCalls: string[] = []
    const startLoopCalls: StartLoopCall[] = []
    const hook = createKeywordDetectorHook(
      createMockPluginInput(toastCalls),
      undefined,
      createMockRalphLoop(startLoopCalls),
    )
    const output = {
      message: {} as Record<string, unknown>,
      parts: [{ type: "text", text: "what is ultrawork" }],
    }

    // when
    await hook["chat.message"]({ sessionID: "main-session", agent: "sisyphus" }, output)

    // then
    expect(toastCalls).not.toContain("Ultrawork Mode Activated")
    expect(startLoopCalls).toHaveLength(0)
    expect(output.parts[0]?.text).toBe("what is ultrawork")
  })

  test("#given mixed-case greeting and keyword #when chat.message fires #then ultrawork activates", async () => {
    const toastCalls: string[] = []
    const startLoopCalls: StartLoopCall[] = []
    const hook = createKeywordDetectorHook(
      createMockPluginInput(toastCalls),
      undefined,
      createMockRalphLoop(startLoopCalls),
    )
    const output = {
      message: {} as Record<string, unknown>,
      parts: [{ type: "text", text: "HI THERE UltraWork" }],
    }

    await hook["chat.message"]({ sessionID: "main-session", agent: "sisyphus" }, output)

    expect(toastCalls).toContain("Ultrawork Mode Activated")
    expect(startLoopCalls).toHaveLength(1)
    expect(startLoopCalls[0]?.prompt).toBe("Complete the task as instructed")
    expect(output.parts[0]?.text).toContain("ULTRAWORK MODE ENABLED!")
  })

  test("#given mixed-case Hey and ULW #when chat.message fires #then ultrawork activates", async () => {
    const toastCalls: string[] = []
    const startLoopCalls: StartLoopCall[] = []
    const hook = createKeywordDetectorHook(
      createMockPluginInput(toastCalls),
      undefined,
      createMockRalphLoop(startLoopCalls),
    )
    const output = {
      message: {} as Record<string, unknown>,
      parts: [{ type: "text", text: "Hey ULW" }],
    }

    await hook["chat.message"]({ sessionID: "main-session", agent: "sisyphus" }, output)

    expect(toastCalls).toContain("Ultrawork Mode Activated")
    expect(startLoopCalls).toHaveLength(1)
    expect(output.parts[0]?.text).toContain("ULTRAWORK MODE ENABLED!")
  })

  test("#given heavy leading and trailing whitespace around greeting #when chat.message fires #then ultrawork activates", async () => {
    const toastCalls: string[] = []
    const startLoopCalls: StartLoopCall[] = []
    const hook = createKeywordDetectorHook(
      createMockPluginInput(toastCalls),
      undefined,
      createMockRalphLoop(startLoopCalls),
    )
    const output = {
      message: {} as Record<string, unknown>,
      parts: [{ type: "text", text: "   hello ultrawork   " }],
    }

    await hook["chat.message"]({ sessionID: "main-session", agent: "sisyphus" }, output)

    expect(toastCalls).toContain("Ultrawork Mode Activated")
    expect(startLoopCalls).toHaveLength(1)
    expect(startLoopCalls[0]?.prompt).toBe("Complete the task as instructed")
    expect(output.parts[0]?.text).toContain("ULTRAWORK MODE ENABLED!")
  })

  test("#given each greeting variant with ultrawork #when chat.message fires #then ultrawork activates for all", async () => {
    const greetings = ["hi", "hello", "hey", "hiya", "greetings"]
    for (const greeting of greetings) {
      const toastCalls: string[] = []
      const startLoopCalls: StartLoopCall[] = []
      const hook = createKeywordDetectorHook(
        createMockPluginInput(toastCalls),
        undefined,
        createMockRalphLoop(startLoopCalls),
      )
      const output = {
        message: {} as Record<string, unknown>,
        parts: [{ type: "text", text: `${greeting} ultrawork` }],
      }

      await hook["chat.message"]({ sessionID: "main-session", agent: "sisyphus" }, output)

      expect(toastCalls).toContain("Ultrawork Mode Activated")
      expect(startLoopCalls).toHaveLength(1)
    }
  })

  test("#given greeting with there and ulw #when chat.message fires #then ultrawork activates for all greeting variants", async () => {
    const greetings = ["hi there", "hello there", "hey there", "hiya there", "greetings there"]
    for (const greeting of greetings) {
      const toastCalls: string[] = []
      const startLoopCalls: StartLoopCall[] = []
      const hook = createKeywordDetectorHook(
        createMockPluginInput(toastCalls),
        undefined,
        createMockRalphLoop(startLoopCalls),
      )
      const output = {
        message: {} as Record<string, unknown>,
        parts: [{ type: "text", text: `${greeting} ulw` }],
      }

      await hook["chat.message"]({ sessionID: "main-session", agent: "sisyphus" }, output)

      expect(toastCalls).toContain("Ultrawork Mode Activated")
      expect(startLoopCalls).toHaveLength(1)
    }
  })

  test("#given repeated greeting before ulw #when chat.message fires #then ultrawork stays disabled", async () => {
    const toastCalls: string[] = []
    const startLoopCalls: StartLoopCall[] = []
    const hook = createKeywordDetectorHook(
      createMockPluginInput(toastCalls),
      undefined,
      createMockRalphLoop(startLoopCalls),
    )
    const output = {
      message: {} as Record<string, unknown>,
      parts: [{ type: "text", text: "hello hello ulw" }],
    }

    await hook["chat.message"]({ sessionID: "main-session", agent: "sisyphus" }, output)

    expect(toastCalls).not.toContain("Ultrawork Mode Activated")
    expect(startLoopCalls).toHaveLength(0)
  })

  test("#given greeting with extra words before ultrawork #when chat.message fires #then ultrawork stays disabled", async () => {
    const toastCalls: string[] = []
    const startLoopCalls: StartLoopCall[] = []
    const hook = createKeywordDetectorHook(
      createMockPluginInput(toastCalls),
      undefined,
      createMockRalphLoop(startLoopCalls),
    )
    const output = {
      message: {} as Record<string, unknown>,
      parts: [{ type: "text", text: "hey please run ultrawork" }],
    }

    await hook["chat.message"]({ sessionID: "main-session", agent: "sisyphus" }, output)

    expect(toastCalls).not.toContain("Ultrawork Mode Activated")
    expect(startLoopCalls).toHaveLength(0)
  })

  test("#given greeting with trailing text after ultrawork #when chat.message fires #then ultrawork stays disabled", async () => {
    const toastCalls: string[] = []
    const startLoopCalls: StartLoopCall[] = []
    const hook = createKeywordDetectorHook(
      createMockPluginInput(toastCalls),
      undefined,
      createMockRalphLoop(startLoopCalls),
    )
    const output = {
      message: {} as Record<string, unknown>,
      parts: [{ type: "text", text: "hi ultrawork now please" }],
    }

    await hook["chat.message"]({ sessionID: "main-session", agent: "sisyphus" }, output)

    expect(toastCalls).not.toContain("Ultrawork Mode Activated")
    expect(startLoopCalls).toHaveLength(0)
  })

  test("#given non-greeting word before ulw #when chat.message fires #then ultrawork stays disabled", async () => {
    const toastCalls: string[] = []
    const startLoopCalls: StartLoopCall[] = []
    const hook = createKeywordDetectorHook(
      createMockPluginInput(toastCalls),
      undefined,
      createMockRalphLoop(startLoopCalls),
    )
    const output = {
      message: {} as Record<string, unknown>,
      parts: [{ type: "text", text: "yo ulw" }],
    }

    await hook["chat.message"]({ sessionID: "main-session", agent: "sisyphus" }, output)

    expect(toastCalls).not.toContain("Ultrawork Mode Activated")
    expect(startLoopCalls).toHaveLength(0)
  })
})
