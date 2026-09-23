# Linear / Modern UI Makeover

Applied to the existing plain HTML/CSS/JavaScript frontend without introducing a new framework.

## Visual system
- Deep-space near-black palette with indigo accent `#5E6AD2`.
- Inter / system sans typography with JetBrains Mono metadata.
- Layered radial lighting, subtle grid/noise, animated ambient blobs.
- Glass-like elevated surfaces with restrained borders and multi-layer shadows.
- 16px cards, 8-10px controls, pill status badges.
- Motion uses expo-out style timing and respects `prefers-reduced-motion`.

## Architecture
- Existing Node.js + Express + PostgreSQL stack is unchanged.
- Existing `styles.css` remains the base stylesheet.
- New `public/linear-modern.css` contains the design-system layer to keep the visual refactor isolated and maintainable.
- `app.js` keeps the current business logic and adds only lightweight spotlight/parallax interactions and permanent dark-theme initialization.
- Existing role-based UI, scheduling, dashboards, profile features, and approval flow are preserved.

## Responsive behavior
- Login/auth layout collapses at tablet widths.
- Sidebar becomes a mobile drawer under 720px.
- Dashboard grids collapse from 4 columns to 2 and then 1.
- Dense records remain inside scrollable regions where the existing UI exposes dedicated data containers.
