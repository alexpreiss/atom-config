'use babel';

import open from 'opn';

export const installInstructions = {
  buttons: [{
    className: 'btn btn-error',
    onDidClick: () => {
      open('https://github.com/avh4/elm-format#atom-elm-format-installation');
    },
    text: 'Open instructions',
  }],
};
