export default {
  rules: {
    "at-rule-no-unknown": [true, { ignoreAtRules: ["layer"] }],
    "block-no-empty": true,
    "color-no-invalid-hex": true,
    "declaration-block-no-duplicate-properties": true,
    "font-family-no-duplicate-names": true,
    "function-calc-no-unspaced-operator": true,
    "no-descending-specificity": true,
    "no-duplicate-selectors": true,
    "property-no-unknown": true,
    "selector-max-id": 0,
    "selector-max-specificity": "0,4,0",
  },
};
