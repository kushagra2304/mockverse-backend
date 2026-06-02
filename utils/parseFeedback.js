const parseFeedback = (feedback) => {
  let is_correct = 0;

  const match = feedback.match(
    /Is the answer correct\?\s*\(?([Yy]es|[Nn]o)\)?/
  );

  if (match) {
    is_correct = match[1].toLowerCase() === "yes" ? 1 : 0;
  } else if (/correct:\s*yes/i.test(feedback)) {
    is_correct = 1;
  } else if (/correct:\s*no/i.test(feedback)) {
    is_correct = 0;
  } else if (/^-+\s*yes\b/i.test(feedback)) {
    is_correct = 1;
  } else if (/^-+\s*no\b/i.test(feedback)) {
    is_correct = 0;
  }

  return is_correct;
};

export default parseFeedback;