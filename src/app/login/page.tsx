"use client";

/** /login 独立登录页：与 AuthBoundary 共用登录界面；登录成功回主页。 */
import { useRouter } from "next/navigation";
import { LoginScreen } from "@/features/auth/login-screen";

export default function LoginPage(): React.ReactElement {
  const router = useRouter();
  return <LoginScreen onSignedIn={() => router.push("/")} />;
}
