/**
 * Tree-sitter query for matching various Python constructs.
 *
 */
export default `
(class_definition
  name: (identifier) @name.definition.class) @definition.class

(function_definition
  name: (identifier) @name.definition.function) @definition.function
`