"use client";

import { useEffect, useState } from "react";
import { exchangeCode } from "@/lib/auth";
import { loadRuntimeConfig } from "@/lib/runtime-config";

export default function AuthCallback() {
  const [message, setMessage] = useState("Completing Google sign-in...");

  useEffect(() => {
    async function finish() {
      const config = await loadRuntimeConfig();
      const code = new URLSearchParams(window.location.search).get("code");
      if (!config || !code) {
        setMessage("Missing Cognito configuration or authorization code.");
        return;
      }
      try {
        await exchangeCode(config, code);
        window.location.href = "/";
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Sign-in failed.");
      }
    }
    void finish();
  }, []);

  return (
    <main className="min-h-screen bg-[#f3f4f6] p-8 text-[#0f1933]">
      <div className="mx-auto max-w-xl rounded-3xl bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold">Future Founders Login</h1>
        <p className="mt-3">{message}</p>
      </div>
    </main>
  );
}
