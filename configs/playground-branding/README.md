# Playground icon

Red variant of the shipped Zen macOS icon, edited with the built-in imagegen tool. The PNG retains transparency and is the source for the ICNS container. Packaging replaces the icon only in the derived Playground application, before signing. Main branding is unchanged. This directory is outside `configs/branding`: Surfer enumerates every directory there as a complete compile-time brand.

To rebuild the ICNS on macOS, resize the PNG into standard 16, 32, 128, 256 and 512 point iconset entries at 1x and 2x, then use `iconutil -c icns`. No build-time image generation or recoloring is needed.

Generation prompt:

Use case: precise-object-edit. Asset type: macOS Zen Playground app icon. Image 1 is the edit target: the existing Zen app icon. Make a red-toned variant of this exact icon. Change ONLY the charcoal rounded-square tile surface to a clearly recognizable deep warm red/burgundy (#8d242b). Preserve the ivory color, precise centered arrangement, dimensions and stroke widths of all three concentric rings; preserve the tile silhouette, corner radius, original proportions, original subtle edge shadow, spacing, framing and canvas. Do not redraw the symbol, add badges, text, gradients, extra circles, or new design elements. The exterior outside the rounded-square icon must remain genuinely transparent, including the existing soft edge shadow. Deliver one square app icon with the same design at 1024 by 1024.
