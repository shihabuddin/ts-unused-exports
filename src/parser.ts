import { existsSync, readFileSync } from 'fs';
import { dirname, resolve, relative, join } from 'path';
import * as ts from 'typescript';
import { File, Imports } from './types';

const TRIM_QUOTES = /^['"](.*)['"]$/;

interface FromWhat {
  from: string
  what: string[]
}

const star = ['*'];

const getFrom = (moduleSpecifier:ts.Expression) =>
  moduleSpecifier
  .getText()
  .replace(TRIM_QUOTES, '$1')
  .replace(/\/index$/, '');

const extractImport = (decl:ts.ImportDeclaration) : FromWhat => {
  const from = getFrom(decl.moduleSpecifier);
  const { importClause } = decl;
  if (!importClause) return {
    from,
    what: star
  };

  const { namedBindings } = importClause;
  const importDefault = !!importClause.name
    ? ['default']
    : [];
  const importStar =
    namedBindings
    && !!(namedBindings as ts.NamespaceImport).name
    ? star
    : [];
  const importNames =
    namedBindings
    && !importStar.length
    ? (namedBindings as ts.NamedImports)
      .elements
      .map(e => (e.propertyName || e.name).text)
    : [];

  return {
    from,
    what: importDefault.concat(importStar, importNames)
  };
};

const extractExportFromImport = (decl:ts.ExportDeclaration) : FromWhat => {
  const { moduleSpecifier, exportClause } = decl;
  if (!moduleSpecifier) return {
    from: '',
    what: []
  };

  const what = exportClause
    ? exportClause.elements
      .map(e => (e.propertyName || e.name).text)
    : star;

  return {
    from: getFrom(moduleSpecifier),
    what
  };
};

const extractExport = (path:string, node:ts.Node):string => {
  switch (node.kind) {
    case ts.SyntaxKind.VariableStatement:
      return (node as ts.VariableStatement)
        .declarationList
        .declarations[0]
        .name
        .getText();
    case ts.SyntaxKind.FunctionDeclaration:
      const { name } = (node as ts.FunctionDeclaration);
      return name
        ? name.text
        : 'default';
    default: {
      console.warn(`WARN: ${path}: unknown export node (kind:${node.kind})`);
      break;
    }
  }
  return '';
};

const relativeTo = (rootDir:string, file:string, path:string) : string =>
  relative(rootDir, resolve(dirname(file), path));

const isRelativeToBaseDir = (baseDir:string, from:string) =>
  existsSync(resolve(baseDir, `${from}.ts`))
  || existsSync(resolve(baseDir, `${from}.tsx`))
  || existsSync(resolve(baseDir, from, 'index.ts'))
  || existsSync(resolve(baseDir, from, 'index.tsx'))
  ;

const hasModifier = (node:ts.Node, mod:ts.SyntaxKind) =>
  node.modifiers
  && node.modifiers .filter(m => m.kind === mod).length > 0;

const mapFile = (
  rootDir:string,
  path:string,
  file:ts.SourceFile,
  baseUrl?:string
) : File => {
  const imports:Imports = {};
  let exports:string[] = [];
  const name = relative(rootDir, path).replace(/([\\/]index)?\.[^.]*$/, '');
  const baseDir = baseUrl && resolve(rootDir, baseUrl);
  const addImport = (fw:FromWhat) => {
    const { from, what } = fw;
    const key = from[0] == '.'
      ? relativeTo(rootDir, path, from)
      : baseDir && isRelativeToBaseDir(baseDir, from)
        ? join(baseUrl, from)
        : undefined;
    if (!key) return undefined;
    const items = imports[key] || [];
    imports[key] = items.concat(what);
    return key;
  };

  ts.forEachChild(file, (node:ts.Node) => {
    const { kind } = node;

    if (kind === ts.SyntaxKind.ImportDeclaration) {
      addImport(extractImport(node as ts.ImportDeclaration));
      return;
    }

    if (kind === ts.SyntaxKind.ExportAssignment) {
      exports.push('default');
      return;
    }
    if (kind === ts.SyntaxKind.ExportDeclaration) {
      const fw = extractExportFromImport(node as ts.ExportDeclaration);
      const key = addImport(fw);
      if (key) {
        const { what } = fw;
        if (what == star) {
          exports.push(`*:${key}`);
        } else {
          exports = exports.concat(what);
        }
      }
      return;
    }

    if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      const decl = (node as ts.DeclarationStatement);
      const name = decl.name
        ? decl.name.text
        : extractExport(path, node);
      if (name) exports.push(name);
    }
  });

  return {
    path: name,
    imports,
    exports
  };
};

const parseFile = (rootDir:string, path:string, baseUrl?:string) : File =>
  mapFile(
    rootDir,
    path,
    ts.createSourceFile(
      path,
      readFileSync(path, { encoding: 'utf8' }),
      ts.ScriptTarget.ES2015,
      /*setParentNodes */ true
    ),
    baseUrl
  );

const parsePaths = (
  rootDir:string,
  paths:string[],
  baseUrl:string|undefined,
  otherFiles:File[],
  excludes: string[]
):File[] => {
  const files = otherFiles.concat(
    paths
    .map(path => parseFile(rootDir, resolve(rootDir, path), baseUrl))
  );

  const found:{ [path:string]:File } = {};
  files.forEach(f => found[f.path] = f);

  const missingImports = ([] as string[])
    .concat(...files.map(f => Object.keys(f.imports)))
    .filter(i => !found[i] && !excludes.some(exclude => i.indexOf(exclude, i.length - exclude.length) >= 0))
    .map(i => `${i}.ts`);

  return missingImports.length
    ? parsePaths(rootDir, missingImports, baseUrl, files, excludes)
    : files;
};

export default (rootDir:string, paths:string[], baseUrl?:string, excludes?: string[]):File[] =>
  parsePaths(rootDir, paths, baseUrl, [], excludes || []);
