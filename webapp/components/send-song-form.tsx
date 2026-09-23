"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Status = "idle" | "sending" | "error";

export default function SendSongForm({ taskId }: { taskId: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [sentTo, setSentTo] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(true);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("sending");
    try {
      const res = await fetch("/api/send-song", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, email }),
      });
      if (!res.ok) {
        setStatus("error");
        return;
      }
      setSentTo((prev) => [...prev, email.trim()]);
      setEmail("");
      setStatus("idle");
      setShowForm(false);
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="space-y-3 border-t border-border pt-4">
      {sentTo.length > 0 && (
        <div className="space-y-1">
          {sentTo.map((addr, i) => (
            <p key={`${addr}-${i}`} className="text-sm font-medium text-success">
              ✓ Το τραγούδι στάλθηκε στο {addr}
            </p>
          ))}
          <p className="text-xs text-muted-foreground">
            Αν δεν το δείτε σε λίγα λεπτά, κοιτάξτε και στα Ανεπιθύμητα (Spam).
          </p>
        </div>
      )}

      {showForm ? (
        <form onSubmit={send} className="space-y-2">
          <label htmlFor="send-song-email" className="text-sm font-medium">
            {sentTo.length > 0
              ? "Σε ποιο άλλο email να το στείλουμε;"
              : "Θέλετε το τραγούδι στο email σας;"}
          </label>
          <div className="flex gap-2">
            <input
              id="send-song-email"
              type="email"
              required
              autoFocus={sentTo.length > 0}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (status === "error") setStatus("idle");
              }}
              className="flex-1 min-w-0 rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <Button type="submit" variant="3d-primary" className="h-10 px-4" disabled={status === "sending"}>
              {status === "sending" ? "Αποστολή..." : "Αποστολή"}
            </Button>
          </div>
          {status === "error" && (
            <p className="text-sm text-destructive">Η αποστολή απέτυχε. Δοκιμάστε ξανά.</p>
          )}
          <p className="text-xs text-muted-foreground">
            Χρησιμοποιούμε το email σας μόνο για να σας στείλουμε το τραγούδι.
          </p>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="text-sm font-medium text-primary hover:text-primary/80 transition"
        >
          ✉ Αποστολή και σε άλλο email
        </button>
      )}
    </div>
  );
}
