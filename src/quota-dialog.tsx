import type { JSX } from "solid-js"
import { TextAttributes, type RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { parseQuotaLine, type QuotaTone } from "./plugin/ui/quota.ts"

export interface QuotaKeymapCommand {
  id?: string
  title?: string
  group?: string
  palette?: true
  slash?: { name: string; aliases?: string[] }
  bind?: string
  run: (input?: string) => void | false | Promise<void>
}

export interface QuotaDialogKeymapLayer {
  mode: string
  commands?: ReadonlyArray<QuotaKeymapCommand>
}

/** Subset of the resolved dialog theme tokens this dialog needs. */
export interface QuotaDialogTheme {
  readonly text: {
    readonly base: RGBA
    readonly muted: RGBA
    readonly faint: RGBA
    readonly feedback: Readonly<Record<"success" | "warning" | "error", { readonly base: RGBA }>>
    readonly action: { readonly primary: { readonly focused: RGBA } }
  }
  readonly background: {
    readonly action: { readonly primary: { readonly focused: RGBA } }
  }
}

export interface QuotaDialogHost {
  readonly renderer: { readonly height: number }
  readonly theme: { surface(name: "dialog"): QuotaDialogTheme }
  readonly ui: {
    readonly dialog: {
      set(options: { size?: "medium" | "large" | "xlarge"; centered?: boolean }): void
      show(render: () => JSX.Element, onClose?: () => void): void
      clear(): void
    }
  }
  readonly keymap: {
    layer(factory: () => QuotaDialogKeymapLayer): void
  }
}

/**
 * Shows the quota report in a centered dialog whose body scrolls with a bounded
 * height, using the same layout and theme tokens as OpenCode's own dialogs.
 *
 * `dialog.show` resets the dialog presentation to medium and not centered, so
 * the size and centering have to be applied from inside the rendered content.
 */
export function showQuotaDialog(host: QuotaDialogHost, title: string, message: string): Promise<void> {
  return new Promise<void>(resolve => {
    let settled = false
    let scroll: ScrollBoxRenderable | undefined

    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const close = () => host.ui.dialog.clear()
    const page = Math.max(6, Math.floor(host.renderer.height * 0.65) - 6)

    host.ui.dialog.show(() => {
      host.ui.dialog.set({ size: "medium", centered: true })
      const theme = host.theme.surface("dialog")

      const tone = (value: QuotaTone): RGBA => {
        if (value === "success") return theme.text.feedback.success.base
        if (value === "warning") return theme.text.feedback.warning.base
        if (value === "error") return theme.text.feedback.error.base
        return theme.text.muted
      }

      const inline = (line: string): Array<JSX.Element | string> => {
        const parsed = parseQuotaLine(line)
        switch (parsed.kind) {
          case "blank":
            return [""]
          case "title":
            return [<b>{parsed.text}</b>]
          case "bar":
            return [
              " ".repeat(parsed.indent) + "[",
              <span style={{ fg: tone(parsed.tone) }}>{parsed.filled}</span>,
              <span style={{ fg: theme.text.faint }}>{parsed.empty}</span>,
              "] " + parsed.percent,
            ]
          case "status":
            return [
              " ".repeat(parsed.indent),
              <span style={{ fg: tone(parsed.tone) }}>{parsed.text}</span>,
            ]
          case "text":
            return [" ".repeat(parsed.indent) + parsed.text]
        }
      }

      const lines = message.split("\n")
      const body = lines.flatMap((line, index) => index < lines.length - 1 ? [...inline(line), "\n"] : inline(line))

      host.keymap.layer(() => ({
        mode: "modal",
        commands: [
          { bind: "return", title: "Close", group: "Dialog", run: close },
          { bind: "escape", title: "Close", group: "Dialog", run: close },
          { bind: "up", title: "Scroll up", group: "Dialog", run: () => scroll?.scrollBy(-1) },
          { bind: "down", title: "Scroll down", group: "Dialog", run: () => scroll?.scrollBy(1) },
          { bind: "pageup", title: "Previous page", group: "Dialog", run: () => scroll?.scrollBy(-page) },
          { bind: "pagedown", title: "Next page", group: "Dialog", run: () => scroll?.scrollBy(page) },
          { bind: "home", title: "Go to top", group: "Dialog", run: () => scroll?.scrollTo(0) },
          { bind: "end", title: "Go to bottom", group: "Dialog", run: () => scroll?.scrollTo(Infinity) },
        ],
      }))

      return (
        <box flexDirection="column" paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
          <box flexDirection="row" justifyContent="space-between" gap={2} flexShrink={0}>
            <text attributes={TextAttributes.BOLD} fg={theme.text.base}>{title}</text>
            <text fg={theme.text.muted} onMouseUp={close}>esc</text>
          </box>
          <scrollbox
            ref={element => (scroll = element)}
            height={page}
            flexShrink={0}
            contentOptions={{ minHeight: 0 }}
            scrollbarOptions={{ visible: false }}
          >
            <text wrapMode="word" fg={theme.text.base}>
              {body}
            </text>
          </scrollbox>
          <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
            <text fg={theme.text.muted}>↑/↓ scroll · pgup/pgdn</text>
            <box
              paddingLeft={3}
              paddingRight={3}
              backgroundColor={theme.background.action.primary.focused}
              onMouseUp={close}
            >
              <text fg={theme.text.action.primary.focused}>ok</text>
            </box>
          </box>
        </box>
      )
    }, finish)
  })
}
