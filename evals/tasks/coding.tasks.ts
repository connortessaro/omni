import type { Task } from "../types.ts";

const CODE_ONLY_INSTRUCTION =
  "Reply with a single JavaScript code block containing only the function definition below (no example usage, no tests, no explanation outside the code block).";

export const codingTasks: Task[] = [
  {
    id: "coding-two-sum",
    category: "coding",
    title: "Two Sum",
    prompt:
      `Write a JavaScript function \`twoSum(nums, target)\` that returns the two ` +
      `indices i < j (as [i, j], ascending) such that nums[i] + nums[j] === target. ` +
      `There is always exactly one valid answer and you may not use the same element twice. ${CODE_ONLY_INSTRUCTION}`,
    grader: {
      type: "code-exec",
      language: "javascript",
      cases: [
        {
          description: "standard case",
          calls: [{ fn: "twoSum", args: [[2, 7, 11, 15], 9] }],
          expected: [[0, 1]],
        },
        {
          description: "answer in the middle",
          calls: [{ fn: "twoSum", args: [[3, 2, 4], 6] }],
          expected: [[1, 2]],
        },
        {
          description: "duplicate values",
          calls: [{ fn: "twoSum", args: [[3, 3], 6] }],
          expected: [[0, 1]],
        },
      ],
    },
  },
  {
    id: "coding-valid-parentheses",
    category: "coding",
    title: "Valid Parentheses",
    prompt:
      `Write a JavaScript function \`isValidParens(s)\` that returns true if the ` +
      `brackets in the string \`s\` (made only of the characters ()[]{}) are balanced ` +
      `and properly nested, false otherwise. An empty string is valid. ${CODE_ONLY_INSTRUCTION}`,
    grader: {
      type: "code-exec",
      language: "javascript",
      cases: [
        { description: "simple pairs", calls: [{ fn: "isValidParens", args: ["()[]{}"] }], expected: [true] },
        { description: "wrong bracket type", calls: [{ fn: "isValidParens", args: ["(]"] }], expected: [false] },
        { description: "wrong nesting order", calls: [{ fn: "isValidParens", args: ["([)]"] }], expected: [false] },
        { description: "properly nested", calls: [{ fn: "isValidParens", args: ["{[]}"] }], expected: [true] },
        { description: "empty string", calls: [{ fn: "isValidParens", args: [""] }], expected: [true] },
      ],
    },
  },
  {
    id: "coding-merge-intervals",
    category: "coding",
    title: "Merge Intervals",
    prompt:
      `Write a JavaScript function \`mergeIntervals(intervals)\` where \`intervals\` is ` +
      `an array of [start, end] pairs (end is inclusive-adjacent, so [1,3] and [3,5] should ` +
      `merge). The input may not be sorted. Return the merged intervals as an array of ` +
      `[start, end] pairs sorted by start. ${CODE_ONLY_INSTRUCTION}`,
    grader: {
      type: "code-exec",
      language: "javascript",
      cases: [
        {
          description: "overlapping and disjoint mixed",
          calls: [{ fn: "mergeIntervals", args: [[[1, 3], [2, 6], [8, 10], [15, 18]]] }],
          expected: [[[1, 6], [8, 10], [15, 18]]],
        },
        {
          description: "touching intervals merge",
          calls: [{ fn: "mergeIntervals", args: [[[1, 4], [4, 5]]] }],
          expected: [[[1, 5]]],
        },
        {
          description: "unsorted input",
          calls: [{ fn: "mergeIntervals", args: [[[5, 7], [1, 2], [0, 4]]] }],
          expected: [[[0, 4], [5, 7]]],
        },
      ],
    },
  },
  {
    id: "coding-valid-palindrome",
    category: "coding",
    title: "Valid Palindrome",
    prompt:
      `Write a JavaScript function \`isPalindromeString(s)\` that returns true if \`s\` ` +
      `reads the same forwards and backwards after removing all non-alphanumeric characters ` +
      `and ignoring case. ${CODE_ONLY_INSTRUCTION}`,
    grader: {
      type: "code-exec",
      language: "javascript",
      cases: [
        {
          description: "punctuation and mixed case",
          calls: [{ fn: "isPalindromeString", args: ["A man, a plan, a canal: Panama"] }],
          expected: [true],
        },
        { description: "not a palindrome", calls: [{ fn: "isPalindromeString", args: ["race a car"] }], expected: [false] },
        { description: "empty string", calls: [{ fn: "isPalindromeString", args: [""] }], expected: [true] },
        {
          description: "only punctuation",
          calls: [{ fn: "isPalindromeString", args: [".,"] }],
          expected: [true],
        },
      ],
    },
  },
  {
    id: "coding-max-subarray",
    category: "coding",
    title: "Maximum Subarray Sum",
    prompt:
      `Write a JavaScript function \`maxSubArray(nums)\` that returns the largest possible ` +
      `sum of a contiguous, non-empty subarray of \`nums\` (which may contain negative ` +
      `numbers). ${CODE_ONLY_INSTRUCTION}`,
    grader: {
      type: "code-exec",
      language: "javascript",
      cases: [
        {
          description: "mixed positive and negative",
          calls: [{ fn: "maxSubArray", args: [[-2, 1, -3, 4, -1, 2, 1, -5, 4]] }],
          expected: [6],
        },
        { description: "single element", calls: [{ fn: "maxSubArray", args: [[1]] }], expected: [1] },
        { description: "all positive", calls: [{ fn: "maxSubArray", args: [[5, 4, -1, 7, 8]] }], expected: [23] },
        { description: "all negative", calls: [{ fn: "maxSubArray", args: [[-1, -2, -3]] }], expected: [-1] },
      ],
    },
  },
  {
    id: "coding-roman-to-int",
    category: "coding",
    title: "Roman Numeral to Integer",
    prompt:
      `Write a JavaScript function \`romanToInt(s)\` that converts a valid Roman numeral ` +
      `string (using I, V, X, L, C, D, M, including subtractive forms like IV and MCM) into ` +
      `its integer value. ${CODE_ONLY_INSTRUCTION}`,
    grader: {
      type: "code-exec",
      language: "javascript",
      cases: [
        { description: "simple additive", calls: [{ fn: "romanToInt", args: ["III"] }], expected: [3] },
        { description: "subtractive form", calls: [{ fn: "romanToInt", args: ["LVIII"] }], expected: [58] },
        { description: "multiple subtractive forms", calls: [{ fn: "romanToInt", args: ["MCMXCIV"] }], expected: [1994] },
      ],
    },
  },
  {
    id: "coding-climbing-stairs",
    category: "coding",
    title: "Climbing Stairs",
    prompt:
      `Write a JavaScript function \`climbStairs(n)\` that returns the number of distinct ` +
      `ways to climb a staircase of \`n\` steps when each move is either 1 or 2 steps. ${CODE_ONLY_INSTRUCTION}`,
    grader: {
      type: "code-exec",
      language: "javascript",
      cases: [
        { description: "n=1", calls: [{ fn: "climbStairs", args: [1] }], expected: [1] },
        { description: "n=2", calls: [{ fn: "climbStairs", args: [2] }], expected: [2] },
        { description: "n=3", calls: [{ fn: "climbStairs", args: [3] }], expected: [3] },
        { description: "n=5", calls: [{ fn: "climbStairs", args: [5] }], expected: [8] },
      ],
    },
  },
  {
    id: "coding-longest-common-prefix",
    category: "coding",
    title: "Longest Common Prefix",
    prompt:
      `Write a JavaScript function \`longestCommonPrefix(strs)\` that returns the longest ` +
      `string prefix shared by every string in the array \`strs\`, or "" if there is none. ${CODE_ONLY_INSTRUCTION}`,
    grader: {
      type: "code-exec",
      language: "javascript",
      cases: [
        {
          description: "shared prefix",
          calls: [{ fn: "longestCommonPrefix", args: [["flower", "flow", "flight"]] }],
          expected: ["fl"],
        },
        {
          description: "no shared prefix",
          calls: [{ fn: "longestCommonPrefix", args: [["dog", "racecar", "car"]] }],
          expected: [""],
        },
        {
          description: "longer shared prefix",
          calls: [
            {
              fn: "longestCommonPrefix",
              args: [["interspecies", "interstellar", "interstate"]],
            },
          ],
          expected: ["inters"],
        },
      ],
    },
  },
];
