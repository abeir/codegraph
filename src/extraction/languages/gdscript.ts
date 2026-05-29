import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const gdscriptExtractor: LanguageExtractor = {
  functionTypes: ['function_definition', 'constructor_definition'],
  classTypes: ['class_definition'],
  methodTypes: ['function_definition', 'constructor_definition'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_definition'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['class_name_statement'],
  importTypes: [],
  callTypes: ['call', 'attribute_call', 'base_call'],
  variableTypes: ['variable_statement', 'export_variable_statement', 'onready_variable_statement'],
  fieldTypes: ['variable_statement', 'export_variable_statement', 'onready_variable_statement', 'signal_statement'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      const rtype = getNodeText(returnType, source);
      if (rtype && rtype.length > 0) sig += ' -> ' + rtype;
    }
    return sig;
  },

  isStatic: (node) => {
    const prev = node.previousNamedSibling;
    if (prev?.type === 'static') return true;
    // Also check for 'static' keyword as unnamed sibling
    let sib = node.previousSibling;
    while (sib) {
      if (sib.type === 'static') return true;
      sib = sib.previousSibling;
    }
    return false;
  },

  isExported: (_node, _source) => {
    // In GDScript, top-level symbols are accessible via preload/load
    return true;
  },

  isConst: (node) => {
    return node.type === 'const_statement';
  },

  visitNode: (node, ctx) => {
    // Handle const_statement as a constant declaration. Visit the value
    // child so that preload/load calls inside const initializers are
    // intercepted and turned into import nodes.
    if (node.type === 'const_statement') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        ctx.createNode('constant', nameNode.text, nameNode, { signature: getNodeText(node, ctx.source) });
      }
      const valueNode = getChildByField(node, 'value');
      if (valueNode) ctx.visitNode(valueNode);
      return true;
    }

    // Handle signal_statement as a method-like node (signals can be connected)
    if (node.type === 'signal_statement') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const params = getChildByField(node, 'parameters');
        let sig = nameNode.text;
        if (params) sig += getNodeText(params, ctx.source);
        ctx.createNode('method', nameNode.text, nameNode, { signature: sig });
      }
      return true;
    }

    // Handle class_name_statement: creates a global alias for the class
    if (node.type === 'class_name_statement') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        ctx.createNode('type_alias', nameNode.text, nameNode);
      }
      return true;
    }

    // Handle extends_statement: create an extends unresolved reference so
    // the resolver can link class chains (e.g. `extends Player` where
    // `Player` is a `class_name` in another file).
    if (node.type === 'extends_statement') {
      const idents = node.descendantsOfType('identifier');
      const firstIdent = idents.length > 0 ? idents[0] : null;
      const parentId = ctx.nodeStack.length > 0 ? ctx.nodeStack[ctx.nodeStack.length - 1] : null;
      if (firstIdent && parentId) {
        ctx.addUnresolvedReference({
          fromNodeId: parentId,
          referenceName: firstIdent.text,
          referenceKind: 'extends',
          line: firstIdent.startPosition.row + 1,
          column: firstIdent.startPosition.column,
        });
      }
      return true;
    }

    // variable_statement children are skipped by the core extractVariable
    // path (skipChildren=true). Intercept here so preload/load calls
    // inside variable initializers still produce import nodes.
    if (node.type === 'variable_statement' ||
        node.type === 'export_variable_statement' ||
        node.type === 'onready_variable_statement') {
      const valueNode = getChildByField(node, 'value');
      if (valueNode) ctx.visitNode(valueNode);
      return false; // let core handle variable extraction
    }

    // Handle preload("path") / load("path") as import declarations.
    // GDScript has no dedicated import node — `preload`/`load` are regular
    // call expressions. Intercept them here so the core doesn't record
    // them as ordinary function calls.
    if (node.type === 'call') {
      const callee = node.namedChild(0);
      if (!callee || callee.type !== 'identifier') return false;
      const calleeName = callee.text;
      if (calleeName !== 'preload' && calleeName !== 'load') return false;

      const args = getChildByField(node, 'arguments');
      if (!args || args.namedChildCount === 0) return false;
      const firstArg = args.namedChild(0);
      if (firstArg?.type !== 'string') return false;

      // Strip quotes from the path string
      const modulePath = firstArg.text.replace(/^["']|["']$/g, '');
      const imp = ctx.createNode('import', modulePath, node, {
        signature: `${calleeName}(${firstArg.text})`,
      });
      if (imp && ctx.nodeStack.length > 0) {
        const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (parentId) {
          ctx.addUnresolvedReference({
            fromNodeId: parentId,
            referenceName: modulePath,
            referenceKind: 'imports',
            line: callee.startPosition.row + 1,
            column: callee.startPosition.column,
          });
        }
      }
      return true;
    }

    return false;
  },

  extractImport: (_node, _source) => {
    return null;
  },
};
