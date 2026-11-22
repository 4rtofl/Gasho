// The settings of Web Push on this browser (docs/iphone.md): whether it is sent notifications, and of which kinds.
import { Bell } from "lucide-react";
import { useState } from "react";
import type { NotificationKind } from "@gasho/protocol";
import { Switch } from "@/components/ui/switch";
import { AccordionSection } from "@/components/ui/unfold-accordion";
import { DEFAULT_KINDS, disablePush, enablePush, iosOutsideApp, NOTIFICATION_KINDS, pushSupported, useSubscriptionEndpoint } from "@/lib/push";
import { useSettingsSectionOpen } from "@/lib/settings-sections";
import { useAppState } from "@/lib/store";

export function PushSettingsSection() {
  const { push, connected, synced } = useAppState();
  const endpoint = useSubscriptionEndpoint(push);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useSettingsSectionOpen("push");
  const mine = endpoint ? push?.subscriptions.find((s) => s.endpoint === endpoint) : undefined;
  const on = Boolean(mine);

  const run = async (f: () => Promise<string | undefined>) => {
    setBusy(true);
    setError(undefined);
    try {
      setError(await f());
    } finally {
      setBusy(false);
    }
  };
  const toggle = (next: boolean) => {
    if (!push) return;
    void run(async () => {
      if (!next) return disablePush();
      const failed = await enablePush(push, DEFAULT_KINDS);
      // Turned on while it is folded, it opens to show the kinds to notify.
      if (!failed) setOpen(true);
      return failed;
    });
  };
  const toggleKind = (kind: NotificationKind, next: boolean) => {
    if (!push || !mine) return;
    const kinds = next ? [...mine.kinds, kind] : mine.kinds.filter((k) => k !== kind);
    void run(() => enablePush(push, kinds));
  };

  let why: string | undefined;
  if (!pushSupported()) {
    why = iosOutsideApp()
      ? "iPhone では、ホーム画面に追加した Gasho から開いたときだけ、通知を受け取れます。"
      : window.isSecureContext
        ? "このブラウザは通知（Web Push）に対応していません。"
        : "通知は、HTTPS の URL で開いたときだけ使えます。";
  } else if (synced && !push) {
    why = "Gasho サーバーが古いため、通知を使えません。Gasho サーバーを更新してください。";
  } else if (Notification.permission === "denied") {
    why = "このブラウザでは、Gasho の通知が拒否されています。端末（ブラウザ）の設定で許可してください。";
  }
  const disabled = Boolean(why) || !push || !connected || busy || endpoint === null;

  return (
    <AccordionSection
      icon={<Bell className="size-4" />}
      title="この端末に通知する"
      description="Gasho を開いていないときも、セッションの名前と通知の種類だけを通知します。会話の中身は出しません。Gasho を前面に出しているあいだは、この端末には通知しません。"
      open={open}
      onOpenChange={setOpen}
      actions={<Switch checked={on} disabled={disabled} onCheckedChange={toggle} aria-label="この端末に通知する" title="この端末に通知する" />}
      notes={
        <>
          {why && <p className="text-xs text-amber-400">{why}</p>}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </>
      }
    >
      {on && mine ? (
        <ul className="divide-y divide-border rounded-xl border border-border bg-background">
          {NOTIFICATION_KINDS.map(({ kind, label, note }) => (
            <li key={kind}>
              <label className="flex cursor-pointer items-center justify-between gap-3 p-3">
                <span className="min-w-0">
                  <span className="block text-sm">{label}</span>
                  <span className="block text-xs text-muted-foreground">{note}</span>
                </span>
                <Switch checked={mine.kinds.includes(kind)} disabled={busy || !connected} onCheckedChange={(v) => toggleKind(kind, v)} />
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">オンにすると、通知する種類を選べます。</p>
      )}
    </AccordionSection>
  );
}
