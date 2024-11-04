/**
 * Tree-sitter query definitions for TypeScript language constructs.
 * 
 * This module exports a string containing tree-sitter queries for identifying
 * various TypeScript language constructs such as function signatures, method
 * signatures, class declarations, and module declarations.
 * 
 * The queries are used to match and capture specific parts of the syntax tree
 * for TypeScript code, allowing for further processing or analysis.
 * 
 * The following constructs are defined:
 * 
 * - `function_signature`: Matches function signatures and captures the function name.
 * - `method_signature`: Matches method signatures and captures the method name.
 * - `abstract_method_signature`: Matches abstract method signatures and captures the method name.
 * - `abstract_class_declaration`: Matches abstract class declarations and captures the class name.
 * - `module`: Matches module declarations and captures the module name.
 * - `function_declaration`: Matches function declarations and captures the function name.
 * - `method_definition`: Matches method definitions and captures the method name.
 * - `class_declaration`: Matches class declarations and captures the class name.
 * 
 * Each query captures the relevant identifier and assigns it a tag for further
 * processing, such as `@name.definition.function` for function names and
 * `@definition.function` for the function definition.
 */
export default `
(function_signature
  name: (identifier) @name.definition.function) @definition.function

(method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(module
  name: (identifier) @name.definition.module) @definition.module

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class
`
