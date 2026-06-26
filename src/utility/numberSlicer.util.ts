/**
 * 실수를 받아서 소숫점 2번째 자리까지 잘라서 반환
 * @param num 172.341538419...
 * @returns 172.34
*/
export function numberSlicer(num: number) {
  const parts = num.toString().split('.');
  const integerPart = parseInt(parts[0]) || 0;
  const decimalPart = parts[1] ? parseFloat('0.' + parts[1].slice(0, 2)) : 0;
  return integerPart + decimalPart;
}