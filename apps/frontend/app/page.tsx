"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/components/auth-provider";

export default function HomePage() {
  const { accessToken, isLoading, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    if (accessToken) {
      if (user?.role === "CANDIDATE") {
        router.replace("/hiring");
        return;
      }
      router.replace("/tasks");
      return;
    }
    router.replace("/login");
  }, [accessToken, isLoading, router, user?.role]);

  return null;
}
