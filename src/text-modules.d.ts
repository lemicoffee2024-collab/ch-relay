// Files imported `with { type: "text" }` (bundled into the compiled exe).
declare module "*.ps1" {
  const text: string;
  export default text;
}
declare module "*.sh" {
  const text: string;
  export default text;
}
declare module "*.md" {
  const text: string;
  export default text;
}
