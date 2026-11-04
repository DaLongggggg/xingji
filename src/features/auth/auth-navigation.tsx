"use client";

import { createContext, type ReactNode } from "react";

/** 仅传递已认证入口的账户展示，身份与退出逻辑仍归AuthBoundary。 */
export const AuthNavigationContext = createContext<ReactNode>(null);
