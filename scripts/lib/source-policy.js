import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const typescriptEntry = fileURLToPath(new URL("../../tooling/node_modules/typescript/lib/typescript.js", import.meta.url));
if (!existsSync(typescriptEntry)) {
  throw new Error("TypeScript tooling is not installed; run: npm run setup:dev");
}
const ts = (await import(pathToFileURL(typescriptEntry).href)).default;

export function repositoryFiles(root, paths) {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return paths.flatMap((path) => filesystemFiles(join(root, path)));
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => join(root, path))
    .filter(existsSync);
}

function filesystemFiles(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && [".git", "node_modules", "coverage", "dist", ".pi"].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...filesystemFiles(child));
    else if (!entry.name.endsWith(".log") && !entry.name.endsWith(".tgz") && entry.name !== ".DS_Store") files.push(child);
  }
  return files;
}

/**
 * Import bindings a file never mentions again, using the same pinned parser as
 * importedSpecifiers rather than a second, weaker scan.
 *
 * A shorthand property, a member name and a local that shadows an import all
 * count as references, so this under-reports rather than over-reports. That is
 * the correct direction for a gate: a false positive gets the rule disabled,
 * while a missed dead import costs only tidiness.
 */
export function unreferencedImportBindings(source) {
  const file = ts.createSourceFile("policy-source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bound = new Set();
  const referenced = new Set();
  const bind = (clause) => {
    if (!clause) return;
    if (clause.name) bound.add(clause.name.text);
    const named = clause.namedBindings;
    if (!named) return;
    if (ts.isNamespaceImport(named)) bound.add(named.name.text);
    else for (const element of named.elements) bound.add(element.name.text);
  };
  const visit = (node) => {
    // Skipped without descending: the names an import introduces are not uses of
    // themselves. A re-export (`export { x } from`) is not an import and is
    // therefore never reported.
    if (ts.isImportDeclaration(node)) return bind(node.importClause);
    if (ts.isImportEqualsDeclaration(node)) return void bound.add(node.name.text);
    if (ts.isIdentifier(node)) referenced.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...bound].filter((name) => !referenced.has(name));
}

/** Use the pinned parser rather than maintaining a partial JavaScript tokenizer. */
export function importedSpecifiers(source) {
  const file = ts.createSourceFile("policy-source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = [];
  const add = (literal) => {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    const text = literal.getText(file);
    // The parser can recover a node from an unterminated string; it is not an import.
    if (text.length < 2 || text.at(0) !== text.at(-1)) return;
    if (!specifiers.includes(literal.text)) specifiers.push(literal.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}
