import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export interface User {
  id: number;
  email: string;
  name: string | null;
  picture: string | null;
  role: "visitor" | "requested" | "commissioner" | "admin";
}

interface AuthState {
  user: User | null;
  clientId: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null, clientId: null, loaded: false,
  refresh: async () => {}, signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const me = await fetch("/api/me").then((r) => r.json());
      setUser(me.user ?? null);
    } catch { setUser(null); }
  }, []);

  useEffect(() => {
    Promise.all([
      fetch("/api/auth/config").then((r) => r.json()).then((c) => setClientId(c.clientId ?? null)).catch(() => {}),
      refresh(),
    ]).finally(() => setLoaded(true));
  }, [refresh]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, clientId, loaded, refresh, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
