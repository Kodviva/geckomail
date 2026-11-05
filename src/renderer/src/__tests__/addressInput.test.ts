import { describe, it, expect } from 'vitest'
import { currentToken, insertAddress, insertContact, matchContacts } from '../addressParse'

describe('currentToken', () => {
  it('boş alanda boş', () => expect(currentToken('', 0)).toBe(''))
  it('tek token', () => expect(currentToken('ali', 3)).toBe('ali'))
  it('virgülden sonraki token, öncekini yok sayar', () =>
    expect(currentToken('a@x.com, bob', 12)).toBe('bob'))
  it('caret ortadaysa o token', () => expect(currentToken('a@x.com, bob', 7)).toBe('a@x.com'))
})

describe('insertAddress', () => {
  it('boş alana ilk adres', () => expect(insertAddress('', 0, 'a@x.com')).toBe('a@x.com, '))
  it('yazılmakta olan tokeni değiştirir', () =>
    expect(insertAddress('a', 1, 'ali@x.com')).toBe('ali@x.com, '))
  it('önceki adresleri korur', () =>
    expect(insertAddress('a@x.com, bo', 11, 'bob@y.com')).toBe('a@x.com, bob@y.com, '))
  it('sondaki artık virgül/boşluğu yutar', () =>
    expect(insertAddress('a@x.com, ', 9, 'b@y.com')).toBe('a@x.com, b@y.com, '))
})

describe('matchContacts', () => {
  const cards = [
    { addr: '', name: 'Ekip', groupId: 9, members: ['a@x.co', 'b@x.co'] },
    { addr: 'ipek@x.co', name: 'İpek Yılmaz', contactId: 1 },
    { addr: 'ali@x.co', name: 'Ali', contactId: 2 },
    { addr: 'son@x.co', name: null }
  ]
  it('Turkish İ matches', () => {
    expect(matchContacts(cards, 'ipek', '').map((c) => c.addr)).toEqual(['ipek@x.co'])
    expect(matchContacts(cards, 'İPEK', '').map((c) => c.addr)).toEqual(['ipek@x.co'])
    expect(matchContacts(cards, 'yilmaz', '').map((c) => c.addr)).toEqual(['ipek@x.co'])
    expect(matchContacts(cards, 'ALİ', '').map((c) => c.addr)).toEqual(['ali@x.co'])
  })
  it('yazılmış adres önerilmez, boş adresli grup süzülmez', () => {
    expect(matchContacts(cards, 'ali', 'ali@x.co, al').map((c) => c.addr)).toEqual([])
    expect(matchContacts(cards, 'ekip', 'ali@x.co, ek').map((c) => c.groupId)).toEqual([9])
  })
  it('selecting group inserts all addresses', () => {
    expect(insertContact('ek', 2, cards[0])).toBe('a@x.co, b@x.co, ')
    expect(insertContact('a@x.co, ek', 10, cards[0])).toBe('a@x.co, b@x.co, ')
    expect(insertContact('al', 2, cards[2])).toBe('ali@x.co, ')
  })
})
