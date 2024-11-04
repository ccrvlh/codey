/**
 * Tree-sitter query for matching various Python constructs.
 *
 * This query matches:
 * - Function definitions (including async functions)
 * - Method definitions within a class
 * - Abstract methods (identified by the "@abstractmethod" decorator)
 * - Abstract class declarations (identified by the "ABC" base class)
 * - Class declarations
 * - Module-level assignments (often used as module declarations)
 */
export default `
; Match function definitions (including async functions)
(function_definition
  name: (identifier) @name.definition.function) @definition.function

; Match method definitions within a class
(function_definition
  name: (identifier) @name.definition.method
  (body (block))) @definition.method

; Match abstract methods specifically (Python doesn’t have direct abstract methods in syntax, so we'll rely on convention like "@abstractmethod" decorator)
(decorator
  name: (identifier) @decorator.abstract_method (#match? @decorator.abstract_method "abstractmethod")) @definition.abstract_method

; Match abstract class declarations (commonly annotated with "ABC" in Python)
(class_definition
  name: (identifier) @name.definition.class
  bases: (argument_list (identifier) @base (#eq? @base "ABC"))) @definition.class.abstract

; Match class declarations
(class_definition
  name: (identifier) @name.definition.class) @definition.class

; Match module-level assignments (often used as module declarations)
(module
  (expression_statement
    (assignment left: (identifier) @name.definition.module))) @definition.module
`