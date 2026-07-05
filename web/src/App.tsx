import { useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import Gallery from "./pages/Gallery";
import PiecePage from "./pages/Piece";
import StudioFloor from "./pages/StudioFloor";
import Exhibit from "./pages/Exhibit";
import Patrons from "./pages/Patrons";
import About from "./pages/About";
import CommissionModal from "./components/CommissionModal";
import { AuthProvider, useAuth } from "./lib/AuthContext";

function Chrome() {
  const [commissionOpen, setCommissionOpen] = useState(false);
  const { user, signOut } = useAuth();
  const location = useLocation();
  const isExhibit = location.pathname.startsWith("/exhibit");

  if (isExhibit) {
    return (
      <Routes>
        <Route path="/exhibit" element={<Exhibit />} />
      </Routes>
    );
  }

  return (
    <>
      <header className="masthead-bar">
        <div className="masthead">
          <NavLink to="/" className="wordmark">
            <span className="diamond" aria-hidden="true" />Lumen Atelier
          </NavLink>
          <nav className="nav">
            <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>Gallery</NavLink>
            <NavLink to="/studio" className={({ isActive }) => (isActive ? "active" : "")}>Studio Floor</NavLink>
            <NavLink to="/exhibit">Exhibit</NavLink>
            <NavLink to="/about" className={({ isActive }) => (isActive ? "active" : "")}>About</NavLink>
            {user?.role === "admin" && (
              <NavLink to="/patrons" className={({ isActive }) => (isActive ? "active" : "")}>Patrons</NavLink>
            )}
            <button className="btn" onClick={() => setCommissionOpen(true)}>Commission</button>
            {user && (
              <span className="account">
                {user.picture && <img src={user.picture} alt="" referrerPolicy="no-referrer" />}
                <button className="linklike" onClick={signOut} title={user.email}>sign out</button>
              </span>
            )}
          </nav>
        </div>
      </header>

      <div className="site">
      <Routes>
        <Route path="/" element={<Gallery onCommission={() => setCommissionOpen(true)} />} />
        <Route path="/piece/:id" element={<PiecePage />} />
        <Route path="/studio" element={<StudioFloor />} />
        <Route path="/about" element={<About />} />
        <Route path="/patrons" element={<Patrons />} />
      </Routes>

      <footer className="colophon">
        <span>
          Lumen Atelier — an autonomous art studio. Conceived, designed, and built by{" "}
          <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer">Claude</a> (Fable 5) —{" "}
          <NavLink to="/about">here's why</NavLink>.
        </span>
        <span>Every piece is a live GLSL shader, painted with math on your GPU.</span>
      </footer>

      {commissionOpen && <CommissionModal onClose={() => setCommissionOpen(false)} />}
      </div>
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Chrome />
    </AuthProvider>
  );
}
