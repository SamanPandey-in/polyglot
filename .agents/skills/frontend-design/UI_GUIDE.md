# 💎 Premium Gold/Neutral Design System (v2.0)

This document defines the **Elite Aesthetic Standards** for the PolyGlot application. It is the single source of truth for maintaining a luxury, high-end visual identity using **Tailwind CSS v4**, **Glassmorphism**, and **Inward Neumorphism**.

---

## 1. 🎯 Design Philosophy (The "Luxury" Look)

Our goal is to create an interface that feels **tactile, professional, and visually memorable**. We move beyond flat design into a world of depth and texture.

- **Tactile Depth**: Using light and shadow (Neumorphism) to make elements feel "carved" or "elevated".
- **Sophisticated Layering**: Using Glassmorphism for transparency and blur.
- **Micro-Detail**: Global noise textures and subtle metallic gradients to provide a "hardware-like" finish.
- **High-End Typography**: Tech-forward, readable, and personality-driven fonts.

---

## 2. 🎨 Elite Color Palette

| Role | Hex | Tailwind Utility | Usage |
| :--- | :--- | :--- | :--- |
| **Premium Gold** | `#D4AF37` | `text-gold` / `bg-gold` | Primary actions, branding, accents |
| **Deep Carbon** | `#0B0B0B` | `bg-card` (Dark) | Secondary dark background |
| **Slate Core** | `#1E293B` | `foreground` | High-contrast text |
| **Glass Base** | `rgba(255,...)` | `.glass-premium` | Elevated surfaces, Sidebar, Header |

---

## 3. ⌨️ Core Typography

We use two primary font families to drive the identity:

1.  **Sora (Display)**: Used for bold headings, brand elements, and tagline expressions. It conveys a modern, tech-focused character.
2.  **Outfit (Body/Sans)**: Used for body text, metadata, and interface controls. It provides exceptional readability with a premium geometric feel.

---

## 4. 🎛️ Custom UI Utilities (The "Secret Sauce")

These classes are defined in [index.css](file:///d:/GitHub/codegraph-ai/client/src/index.css) and should be used to maintain consistency:

### 🔳 Inward Neumorphism (`.shadow-neu-inset`)
Used for cards, inputs, and active navigation items to create a "recessed" tactile effect.
```tsx
<div className="shadow-neu-inset rounded-2xl bg-background/50">...</div>
```

### 🥂 Premium Glass (`.glass-premium`)
Used for Sidebar, Header, and floating modals. Combines transparency, background blur, and a subtle border.
```tsx
<aside className="glass-premium border-r border-border/20">...</aside>
```

### ✨ Metallic Gold Gradient (`.text-gradient-gold`)
Used sparingly for impact headlines or brand focal points.
```tsx
<h1 className="text-gradient-gold">Visual Intelligence</h1>
```

---

## 5. 🌗 Theme Tokens (Tailwind v4 Standard)

Defined in `@theme` block.

- **Backgrounds**: Light (`#F0F2F5`), Dark (`#0B0B0B`).
- **Cards**: Surface level depth with `.shadow-neu-inset`.
- **Transitions**: Use `duration-500` or `duration-700` for smooth, "viscous" animations that feel expensive.

---

## 6. 🧩 Premium Component Rules

### **Cards & Containers**
- **Border Radius**: Use `rounded-2xl` or `rounded-[2.5rem]` for larger layouts.
- **Shadows**: Prefer `shadow-neu-inset` for recessed surfaces. Avoid generic drop shadows.
- **Animations**: Always use `animate-in fade-in slide-in-from-...` with staggered delays (`delay-150`, etc.).

### **Buttons**
- **Action Gold**: `bg-gold text-white hover:bg-gold/90 shadow-lg shadow-gold/20 transition-all active:scale-[0.98]`.
- **Tactile Ghost**: `shadow-neu-inset bg-muted/40 hover:bg-muted/60 transition-colors`.

---

## 7. 🚫 Anti-Patterns (Avoid These)

❌ **Do NOT**:
- Use generic blue, indigo, or purple gradients.
- Use sharp, 1px black borders (use `border-border/20` or `border-gold/10`).
- Overuse the Gold accent (Keep it to ~10% of the screen area).
- Use default browser fonts (Always check `font-display` or `font-sans` classes).
- Use flat cards without depth (Recess them with neumorphism!).

---

## 8. ✅ Pre-Flight UI Checklist

Before a feature is considered "Elite":
- [ ] Does it have subtle entrance animations?
- [ ] Is the typography using `Sora` for headings and `Outfit` for body?
- [ ] Are the cards using the new `rounded-2xl` standards?
- [ ] If it's a surface, does it use either `.glass-premium` (elevated) or `.shadow-neu-inset` (recessed)?
- [ ] Is there **ZERO** residual blue/indigo color?
- [ ] Does the Gold accent use `#D4AF37`?

---

*“Design is not just what it looks like and feels like. Design is how it works.”* – Stay Premium.
