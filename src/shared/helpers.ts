/**
 * Returns the index of the last element in the array where predicate is true, and -1
 * otherwise.
 *
 * @template T - The type of elements in the array.
 * @param {Array<T>} array - The array to search.
 * @param {(value: T, index: number, obj: T[]) => boolean} predicate - The function to test each element.
 * @returns {number} - The last index where the predicate returns true, or -1 if no such element is found.
 */
export function findLastIndex<T>(array: Array<T>, predicate: (value: T, index: number, obj: T[]) => boolean): number {
  let l = array.length
  while (l--) {
    if (predicate(array[l], l, array)) {
      return l
    }
  }
  return -1
}

/**
 * Finds the last element in the array that satisfies the provided predicate function.
 *
 * @template T - The type of elements in the array.
 * @param {Array<T>} array - The array to search through.
 * @param {(value: T, index: number, obj: T[]) => boolean} predicate - The function invoked per iteration.
 * @returns {(T | undefined)} - The last element in the array that satisfies the predicate, or `undefined` if no such element is found.
 */
export function findLast<T>(array: Array<T>, predicate: (value: T, index: number, obj: T[]) => boolean): T | undefined {
  const index = findLastIndex(array, predicate)
  return index === -1 ? undefined : array[index]
}
