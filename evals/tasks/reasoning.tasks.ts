import type { Task } from "../types.ts";

const FORMAT_INSTRUCTION =
  'Show your work briefly, then end your response with a line in exactly this format: "Final answer: <number>".';

export const reasoningTasks: Task[] = [
  {
    id: "reason-train-meeting-time",
    category: "reasoning",
    title: "Two trains closing distance",
    prompt:
      "Two trains start at the same time from stations 450 km apart and move toward each " +
      "other. Train A travels at 60 km/h and Train B travels at 90 km/h. How many hours " +
      `pass before they meet? ${FORMAT_INSTRUCTION}`,
    grader: { type: "numeric", expected: 3, tolerance: 0.01 },
  },
  {
    id: "reason-combined-work-rate",
    category: "reasoning",
    title: "Combined pipe fill rate",
    prompt:
      "Pipe A can fill a tank in 6 hours by itself. Pipe B can fill the same tank in 3 " +
      "hours by itself. If both pipes are opened together, how many minutes will it take " +
      `to fill the tank? ${FORMAT_INSTRUCTION}`,
    grader: { type: "numeric", expected: 120, tolerance: 1 },
  },
  {
    id: "reason-discount-then-tax",
    category: "reasoning",
    title: "Discount followed by sales tax",
    prompt:
      "A jacket costs $80. It is on sale for 25% off. After the discount is applied, an 8% " +
      "sales tax is charged on the discounted price. What is the final price in dollars, " +
      `rounded to the nearest cent? ${FORMAT_INSTRUCTION}`,
    grader: { type: "numeric", expected: 64.8, tolerance: 0.01 },
  },
  {
    id: "reason-age-word-problem",
    category: "reasoning",
    title: "Ages algebra",
    prompt:
      "Sarah is currently 3 times as old as her son. In 12 years, she will be exactly twice " +
      `as old as him. How old is Sarah right now? ${FORMAT_INSTRUCTION}`,
    grader: { type: "numeric", expected: 36, tolerance: 0.01 },
  },
  {
    id: "reason-dice-probability",
    category: "reasoning",
    title: "Two-dice sum probability",
    prompt:
      "You roll two fair six-sided dice. What is the probability that the sum of the two " +
      `dice is exactly 7? Give your answer as a decimal rounded to 4 decimal places. ${FORMAT_INSTRUCTION}`,
    grader: { type: "numeric", expected: 0.1667, tolerance: 0.0002 },
  },
  {
    id: "reason-recipe-scaling",
    category: "reasoning",
    title: "Recipe scaling with rounding",
    prompt:
      "A cookie recipe needs 2.5 cups of flour and makes 18 cookies. You want to make 45 " +
      "cookies for a party, and your measuring cups only measure in half-cup increments " +
      "(0.5 cups). How many cups of flour do you need, rounded UP to the nearest half-cup? " +
      FORMAT_INSTRUCTION,
    grader: { type: "numeric", expected: 6.5, tolerance: 0.01 },
  },
];
