import { useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import Gallery from "./pages/Gallery";
import PiecePage from "./pages/Piece";
import StudioFloor from "./pages/StudioFloor";
import Exhibit from "./pages/Exhibit";
import CommissionModal from "./components/CommissionModal";

export default function App() {
  const [commissionOpen, setCommissionOpen] = useState(false);
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
    <div className="site">
      <header className="masthead">
        <NavLink to="/" className="wordmark">
          <span className="diamond" aria-hidden="true" />Lumen Atelier
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>Gallery</NavLink>
          <NavLink to="/studio" className={({ isActive }) => (isActive ? "active" : "")}>Studio Floor</NavLink>
          <NavLink to="/exhibit">Exhibit</NavLink>
          <button className="btn" onClick={() => setCommissionOpen(true)}>Commission</button>
        </nav>
      </header>

      <Routes>
        <Route path="/" element={<Gallery onCommission={() => setCommissionOpen(true)} />} />
        <Route path="/piece/:id" element={<PiecePage />} />
        <Route path="/studio" element={<StudioFloor />} />
      </Routes>

      <footer className="colophon">
        <span>
          Lumen Atelier — an autonomous art studio. Conceived, designed, and built by{" "}
          <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer">Claude</a> (Fable 5).
        </span>
        <span>Every piece is a live GLSL shader, painted with math on your GPU.</span>
      </footer>

      {commissionOpen && <CommissionModal onClose={() => setCommissionOpen(false)} />}
    </div>
  );
}
