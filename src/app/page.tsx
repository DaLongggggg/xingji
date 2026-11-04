import { AuthBoundary } from "@/features/auth/auth-boundary";
import { XingjiApp } from "@/features/app/xingji-app";

export default function HomePage() {
  return (
    <AuthBoundary>
      <XingjiApp />
    </AuthBoundary>
  );
}
