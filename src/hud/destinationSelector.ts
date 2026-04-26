import { PLANETS, type Planet } from "../data/planets";
import { playCue } from "../util/audio";

interface Args {
  onSelect: (planet: Planet) => void;
}

/** Renders the Destination Selector: 4 holographic planet cards. */
export function mountSelectHud({ onSelect }: Args): () => void {
  const grid = document.getElementById("planet-grid");
  if (!grid) return () => {};

  grid.innerHTML = "";
  const cleanups: Array<() => void> = [];

  PLANETS.forEach((planet, idx) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "planet-card clipped fade-in";
    card.style.animationDelay = `${idx * 80}ms`;
    card.style.setProperty("--planet-light", planet.theme.light);
    card.style.setProperty("--planet-mid", planet.theme.mid);
    card.style.setProperty("--planet-dark", planet.theme.dark);
    card.style.setProperty("--planet-glow", planet.theme.glow);

    card.innerHTML = `
      <div class="planet-card__orb"></div>
      <div class="planet-card__name">${planet.name}</div>
      <div class="planet-card__sub">${planet.tagline}</div>
      <div class="planet-card__stats">
        <div class="telemetry__row">
          <span class="telemetry__label">Distance</span>
          <span class="telemetry__value t-mono">${formatDistance(planet.distanceMkm)}</span>
        </div>
        <div class="telemetry__row">
          <span class="telemetry__label">Gravity</span>
          <span class="telemetry__value t-mono">${planet.gravityG.toFixed(2)} g</span>
        </div>
        <div class="telemetry__row">
          <span class="telemetry__label">Atmos.</span>
          <span class="telemetry__value t-mono">${planet.atmosphere}</span>
        </div>
      </div>
    `;

    const onHover = (): void => playCue("hover");
    const onClick = (): void => {
      playCue("click");
      onSelect(planet);
    };
    card.addEventListener("mouseenter", onHover);
    card.addEventListener("click", onClick);
    cleanups.push(() => {
      card.removeEventListener("mouseenter", onHover);
      card.removeEventListener("click", onClick);
    });

    grid.appendChild(card);
  });

  return () => {
    cleanups.forEach((fn) => fn());
    grid.innerHTML = "";
  };
}

function formatDistance(mkm: number): string {
  if (mkm < 1) {
    return `${(mkm * 1000).toFixed(0)} k km`;
  }
  if (mkm >= 1000) {
    return `${(mkm / 1000).toFixed(2)} B km`;
  }
  return `${mkm.toFixed(0)} M km`;
}
