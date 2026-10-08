export const moduleValue = moduleLater;
const moduleLater = 1;

export function localRead() {
  const value = localLater;
  const localLater = 1;
  return value;
}

export function blockRead() {
  {
    let blockValue = blockLater;
    blockValue++;
    let blockLater = 1;
    blockLater++;
    return [blockValue, blockLater];
  }
}

export const instance = new LaterClass();
class LaterClass {
  value = 1;
}

const readClosure = () => closureLater;
const closureLater = 1;
readClosure();

function readFunction() {
  return functionLater;
}
const functionLater = 1;
readFunction();

export function nestedBlock() {
  {
    const _value = outerLater;
  }
  const outerLater = 1;
}

const construct = () => new ClosureClass();
class ClosureClass {
  value = 1;
}
construct();

callDeclaration();
function callDeclaration() {
  return 1;
}

export const parameterRead = ({
  read = () => laterParameter,
  laterParameter = 1,
} = {}) => read();
