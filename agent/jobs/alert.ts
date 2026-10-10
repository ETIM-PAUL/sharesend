// Alerts for the operator. Always logged; also POSTed as {"text": ...} to ALERT_WEBHOOK_URL when set
// (works with Slack/Discord-style incoming webhooks). Never includes secrets or claim codes.
export async function alert(text: string): Promise<void> {
  console.error(`ALERT: ${text}`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(5000) });
  } catch (e) {
    console.error(`alert webhook failed: ${(e as Error).message}`);
  }
}
