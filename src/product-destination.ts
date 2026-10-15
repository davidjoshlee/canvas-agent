export function productDestination(root: string, destination: string, version?: 1): string {
  if (!version || destination.startsWith(`${root}/Canvas Agent/`)) return destination
  if (!destination.startsWith(`${root}/`))
    throw new Error("Product destination is outside the selected course")
  return `${root}/Canvas Agent/Generated/${destination.slice(root.length + 1)}`
}
