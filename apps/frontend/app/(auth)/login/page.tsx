"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/components/auth-provider";

export default function LoginPage() {
  const { login, accessToken, isLoading, user } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [nextPath, setNextPath] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteEmail = params.get("email");
    const next = params.get("next");
    if (inviteEmail) setEmail(inviteEmail);
    if (next?.startsWith("/")) setNextPath(next);
    if (params.get("passwordChanged") === "1") {
      setSuccessMessage("Password changed. Sign in with your new password.");
    }
  }, []);

  useEffect(() => {
    if (!isLoading && accessToken) {
      router.replace(user?.role === "CANDIDATE" ? nextPath ?? "/hiring" : "/tasks");
    }
  }, [accessToken, isLoading, nextPath, router, user?.role]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);
    setSubmitting(true);
    try {
      const loggedIn = await login(email.trim(), password);
      router.replace(loggedIn.role === "CANDIDATE" ? nextPath ?? "/hiring" : "/tasks");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="relative isolate flex min-h-screen items-center justify-center overflow-hidden px-4 py-8 sm:px-6">
      <div className="absolute inset-0 bg-[#e8dcf3]" />
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{
          backgroundImage:
            "url('https://cdn.prod.website-files.com/68ee2602962f766b40cafdeb/68ee2602962f766b40cafe1c_bg-1%20(1).avif')"
        }}
      />
      <div
        className="absolute inset-0 bg-cover bg-center opacity-90"
        style={{
          backgroundImage:
            "url('https://cdn.prod.website-files.com/68ee2602962f766b40cafdeb/68ee2602962f766b40cafe1b_bg--3%20(1).avif')"
        }}
      />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_84%_14%,rgba(255,170,161,0.4),transparent_35%),radial-gradient(circle_at_12%_12%,rgba(215,194,255,0.36),transparent_36%),radial-gradient(circle_at_70%_70%,rgba(127,49,217,0.34),transparent_48%)]" />
      <div aria-hidden className="pointer-events-none absolute left-[6%] top-[14%] h-20 w-24 rounded-md bg-white/16" />
      <div aria-hidden className="pointer-events-none absolute left-[14%] bottom-[18%] h-24 w-20 rounded-md bg-white/12" />
      <div aria-hidden className="pointer-events-none absolute right-[12%] top-[11%] h-16 w-28 rounded-md bg-white/14" />
      <div aria-hidden className="pointer-events-none absolute right-[8%] bottom-[18%] h-20 w-24 rounded-md bg-white/12" />
      <div aria-hidden className="pointer-events-none absolute bottom-[8%] left-[37%] h-14 w-32 rounded-md bg-white/16" />

      <section className="relative z-10 w-full max-w-[420px] rounded-2xl border border-[#ece6f3] bg-white px-6 py-6 shadow-[0_26px_60px_-28px_rgba(21,15,45,0.58)] sm:px-7 sm:py-7">
        <div className="flex items-center justify-center gap-2.5 text-[#111126]">
          <LogoMark />
          <p className="font-['Aeonik',_IBM_Plex_Sans,_ui-sans-serif] text-[31px] font-medium leading-none">
            OutcomesAI
          </p>
        </div>

        <h1 className="mt-6 text-center font-['Aeonik',_IBM_Plex_Sans,_ui-sans-serif] text-[46px] font-medium leading-[1.04] tracking-[-0.02em] text-[#14132d] sm:text-[50px]">
          Welcome back
        </h1>
        <p className="mx-auto mt-2.5 max-w-[320px] text-center text-[17px] leading-[1.45] text-[#4a4d60]">
          Sign in to continue transcript and metadata correction.
        </p>

        <form className="mt-6 space-y-3.5" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="email" className="sr-only">
              Work Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-12 w-full rounded-[10px] border border-[#c89add] bg-white px-3.5 text-[15px] text-[#171723] outline-none transition placeholder:text-[#8f90a6] focus:border-[#aa5ed3] focus:ring-4 focus:ring-[#ca9ee7]/28"
              placeholder="Work Email"
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="sr-only">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-12 w-full rounded-[10px] border border-[#c89add] bg-white px-3.5 text-[15px] text-[#171723] outline-none transition placeholder:text-[#8f90a6] focus:border-[#aa5ed3] focus:ring-4 focus:ring-[#ca9ee7]/28"
              placeholder="Password"
              required
            />
          </div>

          {error ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          ) : null}
          {successMessage ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {successMessage}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="h-12 w-full rounded-[10px] bg-[#080e36] text-[17px] font-medium text-white shadow-[0_10px_20px_-14px_rgba(8,14,54,0.95)] transition hover:bg-[#0d1447] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#2f3879]/30 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Signing in..." : "Sign In"}
          </button>

          <div className="flex items-center justify-between pt-1 text-[14px] text-[#4d5162]">
            <a
              href="mailto:support@outcomes.ai?subject=Password%20reset%20request"
              className="underline decoration-[0.8px] underline-offset-2 transition hover:text-[#171723]"
            >
              Forgot Password?
            </a>
            <a
              href="mailto:support@outcomes.ai?subject=Support%20request"
              className="underline decoration-[0.8px] underline-offset-2 transition hover:text-[#171723]"
            >
              Contact Support
            </a>
          </div>
        </form>
      </section>
    </main>
  );
}

function LogoMark() {
  return (
    <svg width="25" height="25" viewBox="0 0 27 27" role="img" aria-label="OutcomesAI logo mark" className="shrink-0">
      <path
        d="M17.3865 0C18.7238 1.78225e-05 19.808 1.08104 19.808 2.41451C19.808 3.63312 18.9025 4.64068 17.7258 4.80525V8.43154H21.0666C21.2328 7.16261 22.3211 6.18277 23.639 6.18277C25.0719 6.1828 26.2334 7.34106 26.2334 8.76977C26.2334 10.0426 25.3115 11.1006 24.0972 11.3164V15.3584C25.3115 15.5742 26.2334 16.6325 26.2334 17.9053C26.2334 19.334 25.0719 20.4922 23.639 20.4922C22.3034 20.4922 21.2036 19.4858 21.0605 18.192H17.7258V21.816C18.9025 21.9805 19.808 22.9882 19.808 24.2068C19.808 25.5403 18.7238 26.6213 17.3865 26.6213C16.1643 26.6213 15.1538 25.7184 14.9888 24.5451H10.3241C10.1623 25.5273 9.30707 26.2768 8.2762 26.2768C7.12992 26.2767 6.20068 25.3501 6.20068 24.2071C6.2007 23.1793 6.95215 22.3265 7.93712 22.1651V18.192H3.76292C3.57913 19.0481 2.81604 19.6901 1.90252 19.6901C0.851783 19.6901 0 18.8407 0 17.7929C3.23755e-05 16.8608 0.674227 16.0857 1.5629 15.926V10.7469C0.674218 10.5872 0 9.81212 0 8.87999C3.63902e-05 7.83231 0.851806 6.983 1.90252 6.98296C2.79831 6.98296 3.54944 7.60029 3.75154 8.43154H7.93712V4.45607C6.95215 4.29465 6.20068 3.44206 6.20068 2.41424C6.2007 1.27128 7.12993 0.344734 8.2762 0.344718C9.3069 0.344718 10.1619 1.09388 10.3239 2.07587H14.9888C15.1539 0.902718 16.1644 0 17.3865 0ZM8.61582 18.192V22.1653C9.48998 22.3087 10.18 22.9967 10.3239 23.8683H14.9888C15.1383 22.8057 15.9813 21.965 17.047 21.816V18.192H8.61582ZM17.7258 17.5151H21.0739C21.2518 16.3425 22.219 15.4283 23.4185 15.3276V11.3472C22.2015 11.2451 21.2236 10.3055 21.0666 9.10827H17.7258V17.5151ZM8.61582 17.5151H17.047V9.10827H8.61582V17.5151ZM3.79137 9.10827C3.69176 9.93658 3.05704 10.6008 2.24174 10.747V15.9259C3.04067 16.0692 3.66619 16.71 3.78473 17.5151H7.93712V9.10827H3.79137ZM10.3239 2.75261C10.1801 3.62444 9.49013 4.31258 8.61582 4.45607V8.43154H17.047V4.80525C15.9812 4.65615 15.1382 3.81539 14.9888 2.75261H10.3239Z"
        fill="currentColor"
      />
    </svg>
  );
}
