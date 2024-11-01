class ClineConfig {
  customInstructions?: string[] = [];
  alwaysAllowReadOnly?: boolean = false;
  editAutoScroll?: boolean = false;
  maxFileLineThreshold?: number = 500;
  maxFileLineThresholdBehavior?: "truncate" | "definitions";
  directoryContextMode?: "files" | "tree" = "files";
  directoryContextMaxLines?: number = 200;
  maxMistakeLimit?: number = 3;
}